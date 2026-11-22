/**
 * DualBit Bridge — enumerações dos blocos.
 *
 * ATENÇÃO: os valores numéricos de `DualBitButton` são o ÍNDICE DO BIT na
 * máscara de 16 bits enviada pelo ESP32 e devem coincidir exatamente com
 * `firmware/include/dualbit_protocol.h`.
 */

/**
 * Botões digitais do DualShock 4.
 */
enum DualBitButton {
    //% block="✕ Cross"
    Cross = 0,
    //% block="◯ Circle"
    Circle = 1,
    //% block="□ Square"
    Square = 2,
    //% block="△ Triangle"
    Triangle = 3,
    //% block="L1"
    L1 = 4,
    //% block="R1"
    R1 = 5,
    //% block="L3 (clique analógico esq.)"
    L3 = 6,
    //% block="R3 (clique analógico dir.)"
    R3 = 7,
    //% block="Share"
    Share = 8,
    //% block="Options"
    Options = 9,
    //% block="PS"
    PS = 10,
    //% block="Touchpad (clique)"
    Touchpad = 11,
    //% block="D-Pad ↑"
    Up = 12,
    //% block="D-Pad ↓"
    Down = 13,
    //% block="D-Pad ←"
    Left = 14,
    //% block="D-Pad →"
    Right = 15
}

/**
 * Analógico (stick) a ser lido.
 */
enum DualBitStick {
    //% block="esquerdo"
    Left = 0,
    //% block="direito"
    Right = 1
}

/**
 * Eixo do analógico.
 */
enum DualBitAxis {
    //% block="X (horizontal)"
    X = 0,
    //% block="Y (vertical)"
    Y = 1
}

/**
 * Gatilho analógico.
 */
enum DualBitTrigger {
    //% block="L2"
    L2 = 0,
    //% block="R2"
    R2 = 1
}

/**
 * Motor de vibração do controle.
 */
enum DualBitMotor {
    //% block="ambos"
    Both = 0,
    //% block="fraco (direito/small)"
    Small = 1,
    //% block="forte (esquerdo/large)"
    Large = 2
}

/**
 * Escala de saída dos eixos.
 */
enum DualBitScale {
    //% block="bruto (-128 a 127)"
    Raw = 0,
    //% block="porcentagem (-100 a 100)"
    Percent = 1,
    //% block="largura de pulso (-1023 a 1023)"
    Pwm1023 = 2
}

/**
 * Eixo do acelerômetro (requer sensores habilitados no firmware).
 */
enum DualBitAccelAxis {
    //% block="X"
    X = 0,
    //% block="Y"
    Y = 1,
    //% block="Z"
    Z = 2
}
