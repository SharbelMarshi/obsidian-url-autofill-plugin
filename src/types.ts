export type GateFrameOptionType = 'left' | 'center' | 'right'
export type GateOpenMode = 'tab' | 'window' | 'floating'
export type GateAutoSignInMethod = 'GET' | 'POST'

export type GateFrameOption = {
    id: string
    icon: string
    title: string
    url: string
    profileKey?: string
    hasRibbon?: boolean
    position?: GateFrameOptionType
    openMode?: GateOpenMode
    userAgent?: string
    zoomFactor?: number
    css?: string
    js?: string
    autoSignIn?: boolean
    autoSignInMethod?: GateAutoSignInMethod
    loginUrl?: string
    username?: string
    password?: string
    usernameField?: string
    passwordField?: string
}

export interface PluginSetting {
    uuid: string
    gates: Record<string, GateFrameOption>
}

export interface MarkdownLink {
    title: string
    url: string
}
