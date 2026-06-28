import { session } from 'electron'

const configuredPartitions = new Set<string>()

function getPlatformSegment(): string {
    switch (process.platform) {
        case 'darwin':
            return 'Macintosh; Intel Mac OS X 10_15_7'
        case 'win32':
            return 'Windows NT 10.0; Win64; x64'
        default:
            return 'X11; Linux x86_64'
    }
}

export function getChromeUserAgent(): string {
    const chromeVersion = process.versions.chrome ?? '131.0.0.0'
    return `Mozilla/5.0 (${getPlatformSegment()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
}

export function resolveWebviewUserAgent(siteUrl?: string, customUserAgent?: string): string {
    if (customUserAgent?.trim()) {
        return customUserAgent.trim()
    }

    return getChromeUserAgent()
}

export function prepareWebviewSession(profileKey: string, customUserAgent?: string): void {
    const partition = `persist:${profileKey}`
    const resolvedUserAgent = resolveWebviewUserAgent(undefined, customUserAgent)
    const webviewSession = session.fromPartition(partition)

    webviewSession.setUserAgent(resolvedUserAgent)

    if (configuredPartitions.has(partition)) {
        return
    }

    configuredPartitions.add(partition)
}

export async function clearWebviewSession(profileKey: string): Promise<void> {
    const partition = `persist:${profileKey}`
    await session.fromPartition(partition).clearStorageData()
    configuredPartitions.delete(partition)
}
