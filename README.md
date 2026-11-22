# DualBit

Conecte um controle **PlayStation 4 (DualShock 4)** ao micro:bit usando um
**ESP32** como ponte Bluetooth ↔ Serial (UART).

```
DualShock 4 ──Bluetooth──► ESP32 ──UART 115200──► micro:bit
```

Esta extensão apenas conversa com o firmware **DualBit Bridge**. Grave o
firmware no ESP32 antes de usar os blocos.

## Instalação

No MakeCode (micro:bit): **Extensões → GitHub** → cole

```
https://github.com/ThiagoAlmeidaSiqueira/pxt-dualbit-bridge
```

Firmware, esquema de ligação e protocolo:
**https://github.com/ThiagoAlmeidaSiqueira/dualbit-bridge**

## Ligação

| ESP32 | micro:bit |
|---|---|
| GPIO17 (TX2) | pin 2 (P2) |
| GPIO16 (RX2) | pin 1 (P1) |
| GND | GND |

Ambos são 3,3 V: **sem divisor de tensão**, mas o **GND comum é
obrigatório**. Alimente o ESP32 e o micro:bit separadamente.

## Uso básico

```blocks
DualBit.startDefault()
DualBit.onPS4Connected(function () {
    basic.showIcon(IconNames.Happy)
})
DualBit.onButtonPressed(DualBitButton.Cross, function () {
    DualBit.setLedColor(0x00FF00)
    DualBit.rumblePulse(DualBitMotor.Both, 100, 200)
})
basic.forever(function () {
    if (DualBit.isPS4Connected()) {
        let x = DualBit.axisScaled(DualBitStick.Left, DualBitAxis.X, DualBitScale.Percent)
        // x vai de -100 a 100
    }
})
```

## Grupos de blocos

### Configuração
- **iniciar DualBit TX … RX … baud …** — redireciona a serial para a ponte.
- **iniciar DualBit (TX P1, RX P2, 115200)** — atalho para a ligação padrão.

### Conexão
- **quando o controle PS4 conectar / desconectar**
- **controle PS4 conectado?**
- **fazer o ESP32 se apresentar como …** — define o MAC *de host* (não é o
  MAC do controle!) e reinicia
- **MAC de host salvo no ESP32** — devolve o último valor recebido
- **atualizar MAC do ESP32** / **quando o MAC chegar do ESP32**

> **Sobre pareamento:** o DualShock 4 só conecta ao host cujo endereço
> memorizou. O caminho normal é **esquecer MAC** e parear uma vez com
> **PS + Share** (lightbar pisca 2×). Alternativamente, grave no controle
> o MAC Bluetooth do ESP32 usando o `sixaxispairer` (o MAC do chip aparece
> no console USB com o comando `btmac`).

### Eventos (sem polling)
- **quando o botão … for pressionado / solto**
- **quando a bateria do controle mudar**

### Leitura
- **botão … pressionado?**
- **gatilho L2 / R2 (0-255)**
- **eixo … do analógico … (-128 a 127)**
- **eixo … escala bruto / porcentagem / PWM**
  - bruto: `-128..127`
  - porcentagem: `-100..100`
  - PWM: `-1023..1023`
- **bateria do controle (0 a 100)** — `-1` se desconhecida

### Feedback
- **barra de LED na cor …** (seletor de cores)
- **barra de LED R … G … B …**
- **barra de LED piscando …** (fases em ms, múltiplos de 10)
- **apagar barra de LED**
- **vibração motor … intensidade 0-100**
- **vibração motor … por … ms** (não bloqueia)
- **parar vibração** / **parar vibração e apagar LED**

### Avançado
- **sensores do controle ligado/desligado** (requer firmware com
  `DUALBIT_ENABLE_MOTION=1`)
- **aceleração X/Y/Z**, **rotação Z**
- **ajustar zona morta** (0-64), **ajustar heartbeat** (10-2550 ms)
- **reiniciar o ESP32**, **esquecer MAC**, **ping no ESP32**
- **resultado do último comando** (0 = OK)

## Notas

- A `serial` do micro:bit fica **ocupada** pela ponte; não use blocos de
  escrita serial para depurar depois de iniciar.
- A leitura roda em `control.inBackground` com buffers reaproveitados
  (`rxBuf`/`txBuf` alocados uma única vez) para não estourar a memória do
  micro:bit v1 (erro 020).
- Não há *polling* manual: os eventos usam o EventBus do micro:bit.
- Mapa de bits, comandos e checksums: veja `docs/PROTOCOL.md`.

## Licença

MIT
