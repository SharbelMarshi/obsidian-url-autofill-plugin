export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}

export function isString(value: unknown): value is string {
    return typeof value === 'string'
}
