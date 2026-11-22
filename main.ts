/**
 * =====================================================================
 *  DualBit Bridge — Extensão MakeCode (PXT) para micro:bit
 * =====================================================================
 *  Converte o protocolo binário do ESP32 (ponte Bluetooth <-> UART) em
 *  blocos simples.
 *
 *  Espelho do firmware: `firmware/include/dualbit_protocol.h`.
 *
 *  TX (ESP32 -> micro:bit): [0xAA][tipo][payload...][XOR]
 *  RX (micro:bit -> ESP32): [0x55][cmd][len][payload...][XOR]
 *
 *  Memória: todos os buffers são alocados UMA vez (rxBuf, txBuf) e
 *  reutilizados. A leitura roda em `control.inBackground`, sem polling
 *  em loop apertado, evitando o erro 020 (Out of Memory) no micro:bit v1.
 * =====================================================================
 */

//% color="#1E88E5" weight=100 icon="\uf11b"
//% block="DualBit"
namespace DualBit {
    /* ----------------------------------------------------------------- */
    /*  Constantes do protocolo (DEVEM espelhar o firmware)              */
    /* ----------------------------------------------------------------- */
    const TX_HEADER = 0xAA;
    const HOST_HEADER = 0x55;

    const PKT_INPUT = 0x01;
    const PKT_MOTION = 0x02;
    const PKT_MAC = 0x03;
    const PKT_ACK = 0x04;

    /* tamanho TOTAL do frame, incluindo header + tipo + checksum */
    const LEN_INPUT = 14;
    const LEN_MOTION = 12;
    const LEN_MAC = 9;
    const LEN_ACK = 5;

    const CMD_SET_MAC = 0x01;
    const CMD_GET_MAC = 0x02;
    const CMD_RUMBLE = 0x03;
    const CMD_LED_COLOR = 0x04;
    const CMD_LED_FLASH = 0x05;
    const CMD_LED_OFF = 0x06;
    const CMD_RUMBLE_OFF = 0x07;
    const CMD_REBOOT = 0x08;
    const CMD_SET_DEADZONE = 0x09;
    const CMD_SET_MOTION = 0x0A;
    const CMD_SET_HEARTBEAT = 0x0B;
    const CMD_PING = 0x0C;
    const CMD_CLEAR_MAC = 0x0D;

    /* Flags do byte de status (espelha DB_FLAG_*) */
    const FLAG_CONNECTED = 0x01;

    /* IDs de evento do EventBus.
     *
     * Usamos um ID por (botão, borda) e SEMPRE disparamos com value = 1.
     * Isso evita ambiguidade com MICROBIT_EVT_ANY (que pode ser 0). */
    const EVT_BTN_PRESS = 3000;     /* 3000..3015 */
    const EVT_BTN_RELEASE = 3100;   /* 3100..3115 */
    const EVT_CONNECTED = 3200;
    const EVT_DISCONNECTED = 3201;
    const EVT_BATTERY = 3202;
    const EVT_MAC = 3203;
    const EVT_ACK = 3204;

    /* ----------------------------------------------------------------- */
    /*  Buffers estáticos (alocados uma única vez)                       */
    /* ----------------------------------------------------------------- */
    const RX_CAP = 32;   /* 2 frames de INPUT (14 bytes) + folga */
    const TX_CAP = 24;   /* 4 + payload máximo (16) + folga */

    const rxBuf = control.createBuffer(RX_CAP);
    const txBuf = control.createBuffer(TX_CAP);

    let rxLen = 0;
    let started = false;

    /* ----------------------------------------------------------------- */
    /*  Estado decodificado                                              */
    /* ----------------------------------------------------------------- */
    let buttons = 0;
    let lastButtons = 0;
    let stickLX = 0;
    let stickLY = 0;
    let stickRX = 0;
    let stickRY = 0;
    let triggerL2 = 0;
    let triggerR2 = 0;
    let battery = -1;          /* -1 = desconhecido */
    let lastBattery = -1;
    let connected = false;

    let accX = 0;
    let accY = 0;
    let accZ = 0;
    let gyroZ = 0;

    let macAddr = "";
    let macRequestedAt = -100000;
    let rumbleToken = 0;

    let ackCmd = -1;
    let ackResult = -1;

    /* ================================================================= */
    /*                       INICIALIZAÇÃO                               */
    /* ================================================================= */

    /**
     * Inicia a comunicação serial com o ESP32.
     *
     * Use TX = P1 e RX = P2 (padrão) e 115200 bps.
     * IMPORTANTE: a Serial fica ocupada pela ponte; não use blocos de
     * "serial write" para depuração depois de iniciar.
     */
    //% blockId=dualbit_start
    //% block="iniciar DualBit|TX %tx|RX %rx|baud %rate"
    //% group="Configuração" weight=100
    //% tx.fieldEditor="gridpicker" tx.fieldOptions.columns=3 tx.fieldOptions.tooltips="false"
    //% rx.fieldEditor="gridpicker" rx.fieldOptions.columns=3 rx.fieldOptions.tooltips="false"
    export function start(tx: SerialPin, rx: SerialPin, rate: BaudRate): void {
        if (started) return;
        started = true;

        serial.redirect(tx, rx, rate);
        serial.setRxBufferSize(64);   /* buffer de hardware do micro:bit */

        control.inBackground(rxLoop);
        requestMac();
    }

    /**
     * Atalho para a ligação padrão: TX = P1, RX = P2, 115200 bps.
     */
    //% blockId=dualbit_start_default
    //% block="iniciar DualBit (TX P1, RX P2, 115200)"
    //% group="Configuração" weight=99
    export function startDefault(): void {
        start(SerialPin.P1, SerialPin.P2, BaudRate.BaudRate115200);
    }

    /* ================================================================= */
    /*                    LEITURA EM BACKGROUND                          */
    /* ================================================================= */

    /**
     * Laço de recepção.
     *
     * `serial.readBuffer(1)` bloqueia (SYNC_SLEEP) até chegar 1 byte, o
     * que coloca a fibra para dormir — zero busy-wait. Depois drenamos o
     * que já está no buffer de hardware com `readBuffer(0)` (ASYNC).
     */
    function rxLoop(): void {
        while (true) {
            const one = serial.readBuffer(1);
            if (one && one.length > 0) feedByte(one.getUint8(0));

            const rest = serial.readBuffer(0);
            if (rest) {
                for (let i = 0; i < rest.length; i++) feedByte(rest.getUint8(i));
            }
        }
    }

    function feedByte(b: number): void {
        if (rxLen >= RX_CAP) shift(1);   /* overflow: descarta o mais antigo */
        rxBuf.setUint8(rxLen, b);
        rxLen++;
        parseFrames();
    }

    /** Remove `n` bytes do início do buffer acumulador. */
    function shift(n: number): void {
        if (n >= rxLen) {
            rxLen = 0;
            return;
        }
        const remain = rxLen - n;
        for (let i = 0; i < remain; i++) rxBuf.setUint8(i, rxBuf.getUint8(i + n));
        rxLen = remain;
    }

    /** Máquina de estados de framing: procura 0xAA, valida tamanho e XOR. */
    function parseFrames(): void {
        while (rxLen > 0) {
            /* 1) sincronismo no header */
            let idx = -1;
            for (let i = 0; i < rxLen; i++) {
                if (rxBuf.getUint8(i) == TX_HEADER) {
                    idx = i;
                    break;
                }
            }
            if (idx < 0) {
                rxLen = 0;
                return;
            }
            if (idx > 0) shift(idx);

            if (rxLen < 2) return;

            /* 2) tamanho esperado pelo tipo */
            const type = rxBuf.getUint8(1);
            let len = 0;
            if (type == PKT_INPUT) len = LEN_INPUT;
            else if (type == PKT_MOTION) len = LEN_MOTION;
            else if (type == PKT_MAC) len = LEN_MAC;
            else if (type == PKT_ACK) len = LEN_ACK;
            else {
                shift(1);   /* tipo inválido: descarta o header e ressincroniza */
                continue;
            }
            if (rxLen < len) return;   /* frame incompleto: espera mais bytes */

            /* 3) checksum XOR (tipo + payload) */
            let cs = 0;
            for (let i = 1; i < len - 1; i++) cs ^= rxBuf.getUint8(i);
            if (cs != rxBuf.getUint8(len - 1)) {
                shift(1);   /* checksum ruim: tenta de novo a partir do próximo byte */
                continue;
            }

            handleFrame(type);
            shift(len);
        }
    }

    function handleFrame(type: number): void {
        if (type == PKT_INPUT) {
            buttons = rxBuf.getUint8(3) | (rxBuf.getUint8(4) << 8);
            stickLX = toInt8(rxBuf.getUint8(5));
            stickLY = toInt8(rxBuf.getUint8(6));
            stickRX = toInt8(rxBuf.getUint8(7));
            stickRY = toInt8(rxBuf.getUint8(8));
            triggerL2 = rxBuf.getUint8(9);
            triggerR2 = rxBuf.getUint8(10);

            const rawBatt = rxBuf.getUint8(11);
            battery = rawBatt == 0xFF ? -1 : rawBatt;

            const flags = rxBuf.getUint8(12);
            const isConn = (flags & FLAG_CONNECTED) != 0;
            if (isConn != connected) {
                connected = isConn;
                control.raiseEvent(isConn ? EVT_CONNECTED : EVT_DISCONNECTED, 1);
            }

            if (battery != lastBattery) {
                lastBattery = battery;
                control.raiseEvent(EVT_BATTERY, 1);
            }

            raiseButtonEvents();
        } else if (type == PKT_MOTION) {
            accX = readInt16(3);
            accY = readInt16(5);
            accZ = readInt16(7);
            gyroZ = readInt16(9);
        } else if (type == PKT_MAC) {
            macAddr = macToString();
            control.raiseEvent(EVT_MAC, 1);
        } else if (type == PKT_ACK) {
            ackCmd = rxBuf.getUint8(2);
            ackResult = rxBuf.getUint8(3);
            control.raiseEvent(EVT_ACK, 1);
        }
    }

    function raiseButtonEvents(): void {
        const changed = buttons ^ lastButtons;
        if (changed == 0) return;

        for (let i = 0; i < 16; i++) {
            const bit = 1 << i;
            if (changed & bit) {
                control.raiseEvent(
                    (buttons & bit) ? (EVT_BTN_PRESS + i) : (EVT_BTN_RELEASE + i),
                    1
                );
            }
        }
        lastButtons = buttons;
    }

    function toInt8(v: number): number {
        return v > 127 ? v - 256 : v;
    }

    function readInt16(offset: number): number {
        const lo = rxBuf.getUint8(offset);
        const hi = rxBuf.getUint8(offset + 1);
        const v = lo | (hi << 8);
        return v > 32767 ? v - 65536 : v;
    }

    /* ================================================================= */
    /*                       ENVIO DE COMANDOS                           */
    /* ================================================================= */

    /**
     * Envia [0x55][cmd][len][payload...][xor].
     * O payload já deve estar em txBuf a partir do índice 3.
     */
    function sendFrame(cmd: number, len: number): void {
        txBuf.setUint8(0, HOST_HEADER);
        txBuf.setUint8(1, cmd);
        txBuf.setUint8(2, len);

        let cs = cmd ^ len;
        for (let i = 0; i < len; i++) cs ^= txBuf.getUint8(3 + i);
        txBuf.setUint8(3 + len, cs);

        /* slice aloca um buffer pequeno e descartável (comandos são raros) */
        serial.writeBuffer(txBuf.slice(0, 4 + len));
    }

    function clamp(v: number, lo: number, hi: number): number {
        if (v < lo) return lo;
        if (v > hi) return hi;
        return v;
    }

    function percentToByte(percent: number): number {
        return Math.round(clamp(percent, 0, 100) * 255 / 100);
    }

    function hexVal(c: number): number {
        if (c >= 48 && c <= 57) return c - 48;    /* 0-9 */
        if (c >= 97 && c <= 102) return c - 87;   /* a-f */
        if (c >= 65 && c <= 70) return c - 55;    /* A-F */
        return -1;
    }

    const HEX_CHARS = "0123456789abcdef";

    function byteToHex(v: number): string {
        return HEX_CHARS.charAt((v >> 4) & 0xF) + HEX_CHARS.charAt(v & 0xF);
    }

    /** Lê os 6 bytes do frame MAC e devolve "aa:bb:cc:dd:ee:ff". */
    function macToString(): string {
        let s = "";
        for (let i = 0; i < 6; i++) {
            if (i > 0) s += ":";
            s += byteToHex(rxBuf.getUint8(2 + i));
        }
        return s;
    }

    /* ================================================================= */
    /*                  CONEXÃO / MAC DO CONTROLE                        */
    /* ================================================================= */

    /**
     * Executa quando o DualShock 4 conectar no ESP32.
     */
    //% blockId=dualbit_on_connected
    //% block="quando o controle PS4 conectar"
    //% group="Conexão" weight=95
    export function onPS4Connected(handler: () => void): void {
        control.onEvent(EVT_CONNECTED, 1, handler);
    }

    /**
     * Executa quando o DualShock 4 desconectar do ESP32.
     */
    //% blockId=dualbit_on_disconnected
    //% block="quando o controle PS4 desconectar"
    //% group="Conexão" weight=94
    export function onPS4Disconnected(handler: () => void): void {
        control.onEvent(EVT_DISCONNECTED, 1, handler);
    }

    /**
     * Verdadeiro se o DualShock 4 está conectado ao ESP32.
     */
    //% blockId=dualbit_is_connected
    //% block="controle PS4 conectado?"
    //% group="Conexão" weight=93
    export function isPS4Connected(): boolean {
        return connected;
    }

    /**
     * Faz o ESP32 se apresentar com um MAC Bluetooth específico.
     *
     * ATENÇÃO: este NÃO é o MAC do controle. O DualShock 4 só conecta ao
     * host cujo endereço memorizou (normalmente o do console PS4). Use
     * este bloco para "vestir" o ESP32 com esse endereço.
     *
     * Para pareamento normal, use "esquecer MAC" e pareie com PS+Share.
     * O ESP32 confirma (ACK) e reinicia. Formato: "aa:bb:cc:dd:ee:ff".
     */
    //% blockId=dualbit_set_mac
    //% block="fazer o ESP32 se apresentar como %mac"
    //% mac.defl="1a:2b:3c:4d:5e:6f"
    //% group="Conexão" weight=92
    export function setMacAddress(mac: string): void {
        if (!mac || mac.length != 17) return;

        for (let i = 0; i < 6; i++) {
            const hi = hexVal(mac.charCodeAt(i * 3));
            const lo = hexVal(mac.charCodeAt(i * 3 + 1));
            if (hi < 0 || lo < 0) return;
            txBuf.setUint8(3 + i, (hi << 4) | lo);
        }

        sendFrame(CMD_SET_MAC, 6);

        let s = "";
        for (let i = 0; i < 6; i++) {
            if (i > 0) s += ":";
            s += byteToHex(txBuf.getUint8(3 + i));
        }
        macAddr = s;
    }

    /**
     * Lê o MAC de host salvo no ESP32 (vazio = pareamento aberto).
     *
     * A UART é assíncrona: este bloco pede a leitura e devolve o último
     * valor recebido. Para garantir valor fresco, use junto do evento
     * "quando o MAC chegar".
     */
    //% blockId=dualbit_get_mac
    //% block="MAC de host salvo no ESP32"
    //% group="Conexão" weight=91
    export function macAddress(): string {
        requestMac();
        return macAddr;
    }

    /**
     * Pede ao ESP32 para enviar novamente o MAC salvo.
     */
    //% blockId=dualbit_refresh_mac
    //% block="atualizar MAC do ESP32"
    //% group="Conexão" weight=90
    export function refreshMacAddress(): void {
        macRequestedAt = -100000;
        requestMac();
    }

    function requestMac(): void {
        const now = control.millis();
        if (now - macRequestedAt < 1000) return;   /* no máximo 1x/s */
        macRequestedAt = now;
        sendFrame(CMD_GET_MAC, 0);
    }

    /**
     * Executa quando uma leitura de MAC chega do ESP32.
     */
    //% blockId=dualbit_on_mac
    //% block="quando o MAC chegar do ESP32"
    //% group="Conexão" weight=89
    export function onMacAddressReceived(handler: () => void): void {
        control.onEvent(EVT_MAC, 1, handler);
    }

    /* ================================================================= */
    /*                       BOTÕES E EIXOS                              */
    /* ================================================================= */

    /**
     * Executa quando um botão for pressionado.
     */
    //% blockId=dualbit_on_button_pressed
    //% block="quando o botão %button for pressionado"
    //% group="Eventos" weight=88
    export function onButtonPressed(button: DualBitButton, handler: () => void): void {
        control.onEvent(EVT_BTN_PRESS + button, 1, handler);
    }

    /**
     * Executa quando um botão for solto.
     */
    //% blockId=dualbit_on_button_released
    //% block="quando o botão %button for solto"
    //% group="Eventos" weight=87
    export function onButtonReleased(button: DualBitButton, handler: () => void): void {
        control.onEvent(EVT_BTN_RELEASE + button, 1, handler);
    }

    /**
     * Verdadeiro se o botão está pressionado agora.
     */
    //% blockId=dualbit_is_button_pressed
    //% block="botão %button pressionado?"
    //% group="Leitura" weight=86
    export function isButtonPressed(button: DualBitButton): boolean {
        return (buttons & (1 << button)) != 0;
    }

    /**
     * Valor analógico do gatilho (0 a 255).
     */
    //% blockId=dualbit_trigger
    //% block="gatilho %which (0-255)"
    //% group="Leitura" weight=85
    export function trigger(which: DualBitTrigger): number {
        return which == DualBitTrigger.L2 ? triggerL2 : triggerR2;
    }

    /**
     * Eixo do analógico em valores brutos (-128 a 127).
     */
    //% blockId=dualbit_axis
    //% block="eixo %ax do analógico %stick (-128 a 127)"
    //% group="Leitura" weight=84
    export function axis(stick: DualBitStick, ax: DualBitAxis): number {
        if (stick == DualBitStick.Left)
            return ax == DualBitAxis.X ? stickLX : stickLY;
        return ax == DualBitAxis.X ? stickRX : stickRY;
    }

    /**
     * Eixo do analógico com escala automática.
     *
     * Percent: -128..127  ->  -100..100
     * Pwm1023: -128..127  ->  -1023..1023 (pronto para motores)
     */
    //% blockId=dualbit_axis_scaled
    //% block="eixo %ax do analógico %stick escala %scale"
    //% group="Leitura" weight=83
    export function axisScaled(stick: DualBitStick, ax: DualBitAxis, scale: DualBitScale): number {
        const raw = axis(stick, ax);
        if (scale == DualBitScale.Percent)
            return raw < 0 ? Math.round(raw * 100 / 128) : Math.round(raw * 100 / 127);
        if (scale == DualBitScale.Pwm1023)
            return raw < 0 ? Math.round(raw * 1023 / 128) : Math.round(raw * 1023 / 127);
        return raw;
    }

    /**
     * Nível da bateria do controle (0 a 100). -1 = desconhecido.
     */
    //% blockId=dualbit_battery
    //% block="bateria do controle (0 a 100)"
    //% group="Leitura" weight=82
    export function batteryLevel(): number {
        return battery;
    }

    /**
     * Executa quando o nível da bateria mudar.
     */
    //% blockId=dualbit_on_battery
    //% block="quando a bateria do controle mudar"
    //% group="Eventos" weight=81
    export function onBatteryChanged(handler: () => void): void {
        control.onEvent(EVT_BATTERY, 1, handler);
    }

    /* ================================================================= */
    /*                    ATUADORES (FEEDBACK)                           */
    /* ================================================================= */

    /**
     * Define a cor da barra de LED (lightbar) com o seletor de cores.
     */
    //% blockId=dualbit_led_color
    //% block="barra de LED na cor %color"
    //% color.shadow="colorNumberPicker"
    //% group="Feedback" weight=80
    export function setLedColor(color: number): void {
        const r = (color >> 16) & 0xFF;
        const g = (color >> 8) & 0xFF;
        const b = color & 0xFF;
        setLedRgb(r, g, b);
    }

    /**
     * Define a cor da barra de LED por componentes R, G, B (0 a 255).
     */
    //% blockId=dualbit_led_rgb
    //% block="barra de LED R %r G %g B %b"
    //% r.min=0 r.max=255 g.min=0 g.max=255 b.min=0 b.max=255
    //% group="Feedback" weight=79
    export function setLedRgb(r: number, g: number, b: number): void {
        txBuf.setUint8(3, clamp(r, 0, 255));
        txBuf.setUint8(4, clamp(g, 0, 255));
        txBuf.setUint8(5, clamp(b, 0, 255));
        sendFrame(CMD_LED_COLOR, 3);
    }

    /**
     * Barra de LED piscando.
     *
     * `onMs`/`offMs` são arredondados para múltiplos de 10 ms
     * (limite de 2550 ms de cada fase, imposto pelo hardware do DS4).
     */
    //% blockId=dualbit_led_flash
    //% block="barra de LED piscando R %r G %g B %b ligada %onMs ms desligada %offMs ms"
    //% r.min=0 r.max=255 g.min=0 g.max=255 b.min=0 b.max=255
    //% onMs.min=0 onMs.max=2550 offMs.min=0 offMs.max=2550
    //% group="Feedback" weight=78
    export function setLedFlash(r: number, g: number, b: number, onMs: number, offMs: number): void {
        txBuf.setUint8(3, clamp(r, 0, 255));
        txBuf.setUint8(4, clamp(g, 0, 255));
        txBuf.setUint8(5, clamp(b, 0, 255));
        /* firmware/hardware trabalha em ticks de 10 ms */
        txBuf.setUint8(6, Math.round(clamp(onMs, 0, 2550) / 10));
        txBuf.setUint8(7, Math.round(clamp(offMs, 0, 2550) / 10));
        sendFrame(CMD_LED_FLASH, 5);
    }

    /**
     * Apaga a barra de LED.
     */
    //% blockId=dualbit_led_off
    //% block="apagar barra de LED"
    //% group="Feedback" weight=77
    export function ledOff(): void {
        sendFrame(CMD_LED_OFF, 0);
    }

    /**
     * Liga a vibração.
     *
     * @param motor fraco = direito (small), forte = esquerdo (large)
     * @param intensity 0 a 100
     */
    //% blockId=dualbit_rumble
    //% block="vibração motor %motor intensidade %intensity (0-100)"
    //% intensity.min=0 intensity.max=100
    //% group="Feedback" weight=76
    export function setRumble(motor: DualBitMotor, intensity: number): void {
        const v = percentToByte(intensity);
        let small = 0;
        let large = 0;
        if (motor == DualBitMotor.Both) {
            small = v;
            large = v;
        } else if (motor == DualBitMotor.Small) {
            small = v;
        } else {
            large = v;
        }
        sendRumble(small, large);
    }

    /**
     * Vibra por um tempo e desliga (não bloqueia o programa).
     */
    //% blockId=dualbit_rumble_pulse
    //% block="vibração motor %motor intensidade %intensity (0-100) por %duration ms"
    //% intensity.min=0 intensity.max=100
    //% duration.min=0 duration.max=10000
    //% group="Feedback" weight=75
    export function rumblePulse(motor: DualBitMotor, intensity: number, duration: number): void {
        setRumble(motor, intensity);
        const token = ++rumbleToken;
        control.inBackground(() => {
            basic.pause(duration);
            if (token == rumbleToken) rumbleOff();
        });
    }

    /**
     * Desliga os dois motores de vibração.
     */
    //% blockId=dualbit_rumble_off
    //% block="parar vibração"
    //% group="Feedback" weight=74
    export function rumbleOff(): void {
        ++rumbleToken;   /* cancela pulsos agendados */
        sendRumble(0, 0);
    }

    function sendRumble(small: number, large: number): void {
        txBuf.setUint8(3, clamp(small, 0, 255));
        txBuf.setUint8(4, clamp(large, 0, 255));
        sendFrame(CMD_RUMBLE, 2);
    }

    /**
     * Desliga vibração e apaga a barra de LED de uma vez.
     */
    //% blockId=dualbit_stop_feedback
    //% block="parar vibração e apagar LED"
    //% group="Feedback" weight=73
    export function stopFeedback(): void {
        rumbleOff();
        ledOff();
    }

    /* ================================================================= */
    /*                       SENSORES / AVANÇADO                         */
    /* ================================================================= */

    /**
     * Habilita o envio de giroscópio/acelerômetro pelo ESP32.
     * Requer firmware compilado com DUALBIT_ENABLE_MOTION=1.
     */
    //% blockId=dualbit_enable_motion
    //% block="sensores do controle %enabled"
    //% enabled.shadow="toggleOnOff"
    //% group="Avançado" weight=50
    export function enableMotion(enabled: boolean): void {
        txBuf.setUint8(3, enabled ? 1 : 0);
        sendFrame(CMD_SET_MOTION, 1);
    }

    /**
     * Aceleração em um eixo (requer sensores habilitados).
     */
    //% blockId=dualbit_acceleration
    //% block="aceleração %which"
    //% group="Avançado" weight=49
    export function acceleration(which: DualBitAccelAxis): number {
        if (which == DualBitAccelAxis.X) return accX;
        if (which == DualBitAccelAxis.Y) return accY;
        return accZ;
    }

    /**
     * Giro em torno do eixo Z (giroscópio, requer sensores habilitados).
     */
    //% blockId=dualbit_gyro_z
    //% block="rotação Z"
    //% group="Avançado" weight=48
    export function rotationZ(): number {
        return gyroZ;
    }

    /**
     * Zona morta dos analógicos (0 a 64 unidades). Padrão: 4.
     */
    //% blockId=dualbit_set_deadzone
    //% block="ajustar zona morta dos analógicos para %value"
    //% value.min=0 value.max=64
    //% group="Avançado" weight=47
    export function setDeadzone(value: number): void {
        txBuf.setUint8(3, clamp(value, 0, 64));
        sendFrame(CMD_SET_DEADZONE, 1);
    }

    /**
     * Intervalo máximo entre pacotes (heartbeat) em ms (10 a 2550).
     */
    //% blockId=dualbit_set_heartbeat
    //% block="ajustar heartbeat para %ms ms"
    //% ms.min=10 ms.max=2550
    //% group="Avançado" weight=46
    export function setHeartbeat(ms: number): void {
        txBuf.setUint8(3, Math.round(clamp(ms, 10, 2550) / 10));
        sendFrame(CMD_SET_HEARTBEAT, 1);
    }

    /**
     * Reinicia o ESP32 (reaplica o MAC salvo).
     */
    //% blockId=dualbit_reboot
    //% block="reiniciar o ESP32"
    //% group="Avançado" weight=45
    export function rebootEsp32(): void {
        sendFrame(CMD_REBOOT, 0);
    }

    /**
     * Apaga o MAC salvo: o ESP32 reinicia em modo pareamento aberto.
     */
    //% blockId=dualbit_clear_mac
    //% block="esquecer MAC do controle"
    //% group="Avançado" weight=44
    export function clearMacAddress(): void {
        macAddr = "";
        sendFrame(CMD_CLEAR_MAC, 0);
    }

    /**
     * Testa a comunicação com o ESP32 (resposta em ACK).
     */
    //% blockId=dualbit_ping
    //% block="ping no ESP32"
    //% group="Avançado" weight=43
    export function ping(): void {
        sendFrame(CMD_PING, 0);
    }

    /**
     * Resultado do último ACK: 0 = OK, 1 = comando inválido,
     * 2 = parâmetro inválido, 3 = reiniciando, -1 = nenhum.
     */
    //% blockId=dualbit_last_ack
    //% block="resultado do último comando do ESP32"
    //% group="Avançado" weight=42
    export function lastAckResult(): number {
        return ackResult;
    }

    /**
     * Comando do último ACK recebido (-1 = nenhum).
     */
    //% blockId=dualbit_last_ack_cmd
    //% block="código do último comando confirmado"
    //% group="Avançado" weight=41
    export function lastAckCommand(): number {
        return ackCmd;
    }

    /**
     * Executa quando chega um ACK do ESP32.
     */
    //% blockId=dualbit_on_ack
    //% block="quando o ESP32 confirmar um comando"
    //% group="Avançado" weight=40
    export function onAck(handler: () => void): void {
        control.onEvent(EVT_ACK, 1, handler);
    }
}
