import WebviewTag = Electron.WebviewTag
import { clipboard, shell } from 'electron'
import {
    addIcon,
    Editor,
    ItemView,
    Menu,
    Notice,
    Platform,
    Plugin,
    requestUrl,
    Setting,
    Workspace,
    WorkspaceLeaf
} from 'obsidian'
import { parse } from 'yaml'
import { isRecord } from './guards'
import type { FloatingPreviewManager } from './floating-preview'
import { GateAutoSignInMethod, GateFrameOption, GateFrameOptionType, GateOpenMode, MarkdownLink } from './types'
import {
    clearWebviewSession,
    getChromeUserAgent,
    prepareWebviewSession,
    resolveWebviewUserAgent
} from './webview-session'

export interface OpenViewContext {
    floatingPreview?: FloatingPreviewManager
    gate?: GateFrameOption
}

const DEFAULT_URL = 'about:blank'
const GOOGLE_URL = 'https://google.com'
const EXTENDED_BROWSER_WEBVIEW_CLASS = 'extended-browser-webview'

type FrameReadyCallback = () => void

const pendingFrameRestore = new Map<string, WebviewTag | HTMLIFrameElement>()

export function setPendingFrameRestore(gateId: string, frame: WebviewTag | HTMLIFrameElement): void {
    pendingFrameRestore.set(gateId, frame)
}

export function consumePendingFrameRestore(gateId: string): WebviewTag | HTMLIFrameElement | null {
    const frame = pendingFrameRestore.get(gateId)
    if (frame) {
        pendingFrameRestore.delete(gateId)
    }
    return frame ?? null
}

function getDefaultUserAgent() {
    return getChromeUserAgent()
}

export const getSvgIcon = (siteUrl: string): string => {
    const domain = new URL(siteUrl).hostname
    return `<svg viewBox="0 0 100 100"><image href="https://icon.horse/icon/${domain}" height="100" width="100" /></svg>`
}

export const fetchTitle = async (url: string): Promise<string> => {
    const response = await requestUrl({ url })
    const doc = new DOMParser().parseFromString(response.text, 'text/html')
    return doc.title
}

const hasAutoSignInConfig = (params: Partial<GateFrameOption>): boolean => {
    return (
        params.autoSignIn === true &&
        !!params.loginUrl?.trim() &&
        !!params.username?.trim() &&
        !!params.password &&
        !!params.usernameField?.trim() &&
        !!params.passwordField?.trim()
    )
}

const submitAutoSignInForm = (iframe: HTMLIFrameElement, params: Partial<GateFrameOption>) => {
    const doc = iframe.ownerDocument
    const form = doc.createElement('form')
    form.method = params.autoSignInMethod ?? 'GET'
    form.action = params.loginUrl?.trim() ?? ''
    form.target = iframe.name
    form.addClass('extended-browser-hidden-form')

    const usernameInput = doc.createElement('input')
    usernameInput.type = 'hidden'
    usernameInput.name = params.usernameField?.trim() ?? 'username'
    usernameInput.value = params.username?.trim() ?? ''
    form.appendChild(usernameInput)

    const passwordInput = doc.createElement('input')
    passwordInput.type = 'hidden'
    passwordInput.name = params.passwordField?.trim() ?? 'password'
    passwordInput.value = params.password ?? ''
    form.appendChild(passwordInput)

    doc.body.appendChild(form)
    form.submit()
    form.remove()
}

const createAutoSignInScript = (params: Partial<GateFrameOption>): string => {
    const loginUrl = JSON.stringify(params.loginUrl?.trim() ?? '')
    const method = JSON.stringify(params.autoSignInMethod ?? 'GET')
    const usernameField = JSON.stringify(params.usernameField?.trim() ?? 'username')
    const passwordField = JSON.stringify(params.passwordField?.trim() ?? 'password')
    const username = JSON.stringify(params.username?.trim() ?? '')
    const password = JSON.stringify(params.password ?? '')

    return `
        (() => {
            while (document.body.firstChild) {
                document.body.removeChild(document.body.firstChild);
            }
            const form = document.createElement('form');
            form.method = ${method};
            form.action = ${loginUrl};

            const usernameInput = document.createElement('input');
            usernameInput.type = 'hidden';
            usernameInput.name = ${usernameField};
            usernameInput.value = ${username};
            form.appendChild(usernameInput);

            const passwordInput = document.createElement('input');
            passwordInput.type = 'hidden';
            passwordInput.name = ${passwordField};
            passwordInput.value = ${password};
            form.appendChild(passwordInput);

            document.body.appendChild(form);
            form.submit();
        })();
    `
}

const injectIframeCss = (iframe: HTMLIFrameElement, css: string) => {
    const contentDocument = iframe.contentDocument
    if (!contentDocument) {
        return
    }

    const link = contentDocument.createElement('link')
    link.rel = 'stylesheet'
    link.href = `data:text/css;charset=utf-8,${encodeURIComponent(css)}`
    contentDocument.head.appendChild(link)
}

const runIframeJs = (iframe: HTMLIFrameElement, js: string) => {
    const contentWindow = iframe.contentWindow as (Window & { eval: (source: string) => unknown }) | null
    if (!contentWindow) {
        return
    }

    try {
        contentWindow.eval(js)
    } catch (error) {
        console.error('Extended Browser: failed to run JS in iframe', error)
    }
}

export const createEmptyGateOption = (): GateFrameOption => {
    return {
        id: '',
        title: '',
        icon: '',
        hasRibbon: true,
        position: 'right',
        openMode: 'tab',
        profileKey: 'extended-browser',
        url: '',
        zoomFactor: 1.0,
        userAgent: getDefaultUserAgent(),
        autoSignIn: false,
        autoSignInMethod: 'GET',
        loginUrl: '',
        username: '',
        password: '',
        usernameField: 'username',
        passwordField: 'password'
    }
}

export const normalizeGateOption = (gate: Partial<GateFrameOption>): GateFrameOption => {
    if (gate.url === '' || gate.url === undefined) {
        throw new Error('URL is required')
    }
    if (gate.autoSignInMethod === undefined) {
        gate.autoSignInMethod = 'GET'
    }

    if (gate.id === '' || gate.id === undefined) {
        let seedString = gate.url
        if (gate.profileKey != undefined && gate.profileKey !== 'extended-browser' && gate.profileKey !== 'url-autofill' && gate.profileKey !== 'open-gate' && gate.profileKey !== '') {
            seedString += gate.profileKey
        }
        gate.id = btoa(seedString)
    }

    if (gate.profileKey === '' || gate.profileKey === undefined || gate.profileKey === 'open-gate') {
        gate.profileKey = 'extended-browser'
    }

    if (gate.zoomFactor === 0 || gate.zoomFactor === undefined) {
        gate.zoomFactor = 1
    }

    if (gate.icon === '' || gate.icon === undefined) {
        gate.icon = gate.url?.startsWith('http') ? getSvgIcon(gate.url) : 'globe'
    }

    if (gate.title === '' || gate.title === undefined) {
        gate.title = gate.url
    }

    if (gate.autoSignIn === undefined) {
        gate.autoSignIn = false
    }

    if (gate.loginUrl === undefined) {
        gate.loginUrl = ''
    }

    if (gate.username === undefined) {
        gate.username = ''
    }

    if (gate.password === undefined) {
        gate.password = ''
    }

    if (gate.usernameField === '' || gate.usernameField === undefined) {
        gate.usernameField = 'username'
    }

    if (gate.passwordField === '' || gate.passwordField === undefined) {
        gate.passwordField = 'password'
    }
    if (gate.openMode === undefined) {
        gate.openMode = 'tab'
    }
    return gate as GateFrameOption
}

export const createIframe = (
    params: Partial<GateFrameOption>,
    onReady?: () => void,
    parentDoc: Document = activeDocument
): HTMLIFrameElement => {
    const iframe = parentDoc.createElement('iframe')
    const shouldAutoSignIn = hasAutoSignInConfig(params)
    const targetUrl = shouldAutoSignIn ? 'about:blank' : params.url ?? 'about:blank'

    iframe.name = `extended-browser-frame-${Math.random().toString(36).slice(2)}`
    iframe.setAttribute('allowpopups', '')

    if ('credentialless' in iframe) {
        iframe.setAttribute('credentialless', 'true')
    }

    iframe.setAttribute('src', targetUrl)
    iframe.setAttribute('sandbox', 'allow-forms allow-modals allow-popups allow-presentation allow-same-origin allow-scripts allow-top-navigation-by-user-activation')
    iframe.setAttribute('allow', 'encrypted-media; fullscreen; oversized-images; picture-in-picture; sync-xhr; geolocation')
    iframe.addClass('extended-browser-iframe')

    let submittedAutoSignIn = false

    iframe.addEventListener('load', () => {
        if (shouldAutoSignIn && !submittedAutoSignIn) {
            submittedAutoSignIn = true
            submitAutoSignInForm(iframe, params)
            return
        }

        onReady?.()

        if (params?.css) {
            injectIframeCss(iframe, params.css)
        }

        if (params?.js) {
            runIframeJs(iframe, params.js)
        }
    })

    return iframe
}

export interface WebviewLayoutOptions {
    width: number
    height: number
    deferSrc?: boolean
}

const FRAME_TAB_CLASS = 'extended-browser-tab-frame'
const FRAME_FLOATING_CLASS = 'extended-browser-floating-frame'
const WEBVIEW_INLINE_CLASS = 'extended-browser-webview-inline'

const clearFloatingFrameCssProps = (frameEl: HTMLElement): void => {
    frameEl.setCssProps({
        width: '',
        height: '',
        minWidth: '',
        minHeight: '',
        maxWidth: '',
        maxHeight: '',
        flex: '',
        display: ''
    })
}

const applyWebviewLayout = (webviewTag: WebviewTag, layout: WebviewLayoutOptions): void => {
    webviewTag.classList.add(WEBVIEW_INLINE_CLASS)
    ;(webviewTag as unknown as HTMLElement).setCssProps({
        width: `${layout.width}px`,
        height: `${layout.height}px`
    })
    webviewTag.setAttribute('autosize', 'on')
    webviewTag.setAttribute('minwidth', '0')
    webviewTag.setAttribute('minheight', '0')
}

export const startWebviewNavigation = (webviewTag: WebviewTag, params: Partial<GateFrameOption>): void => {
    const shouldAutoSignIn = hasAutoSignInConfig(params)
    const targetUrl = shouldAutoSignIn ? DEFAULT_URL : params.url ?? DEFAULT_URL

    webviewTag.setAttribute('httpreferrer', params.url ?? GOOGLE_URL)
    webviewTag.setAttribute('src', targetUrl)
}

export const applyTabFrameLayout = (frameEl: HTMLElement): void => {
    frameEl.classList.remove(FRAME_FLOATING_CLASS)
    frameEl.classList.add(FRAME_TAB_CLASS)
    clearFloatingFrameCssProps(frameEl)
}

export const applyFloatingFrameLayout = (frameEl: HTMLElement, width: number, height: number): void => {
    frameEl.classList.remove(FRAME_TAB_CLASS)
    frameEl.classList.add(FRAME_FLOATING_CLASS)
    frameEl.setCssProps({
        width: `${width}px`,
        height: `${height}px`,
        minWidth: `${width}px`,
        minHeight: `${height}px`,
        maxWidth: `${width}px`,
        maxHeight: `${height}px`
    })
}

export const resizeFloatingFrame = (frame: WebviewTag | HTMLIFrameElement, width: number, height: number): void => {
    applyFloatingFrameLayout(frame, width, height)

    if (!(frame instanceof HTMLIFrameElement)) {
        applyWebviewLayout(frame, { width, height })
    }
}

export const navigateFrameBack = (frame: WebviewTag | HTMLIFrameElement | null | undefined): boolean => {
    if (!frame) {
        return false
    }

    if (frame instanceof HTMLIFrameElement) {
        try {
            frame.contentWindow?.history.back()
            return true
        } catch {
            return false
        }
    }

    if (frame.canGoBack()) {
        frame.goBack()
        return true
    }

    return false
}

export const createWebviewTag = (
    params: Partial<GateFrameOption>,
    onReady?: () => void,
    parentDoc: Document = activeDocument,
    layout?: WebviewLayoutOptions
): WebviewTag => {
    const webviewTag = parentDoc.createElement('webview')
    const shouldAutoSignIn = hasAutoSignInConfig(params)
    let submittedAutoSignIn = false
    const profileKey = params.profileKey ?? 'extended-browser'

    webviewTag.setAttribute('partition', `persist:${profileKey}`)
    try {
        prepareWebviewSession(profileKey, params.userAgent)
    } catch (error) {
        console.error('Extended Browser: failed to prepare webview session', error)
    }
    webviewTag.setAttribute('allowpopups', '')

    if (typeof (webviewTag as unknown as { addClass?: (cls: string) => void }).addClass === 'function') {
        webviewTag.addClass(EXTENDED_BROWSER_WEBVIEW_CLASS)
    } else {
        webviewTag.classList.add(EXTENDED_BROWSER_WEBVIEW_CLASS)
    }
    webviewTag.setAttribute('useragent', resolveWebviewUserAgent(params.url, params.userAgent))

    if (layout) {
        applyWebviewLayout(webviewTag, layout)
    }

    if (!layout?.deferSrc) {
        startWebviewNavigation(webviewTag, params)
    }

    webviewTag.addEventListener('new-window', (event: Event) => {
        const popupEvent = event as Event & {
            url?: string
            preventDefault: () => void
        }

        popupEvent.preventDefault()

        if (popupEvent.url) {
            void webviewTag.loadURL(popupEvent.url).catch((error) => {
                console.error('Extended Browser: failed to open popup URL in webview', error)
            })
        }
    })

    webviewTag.addEventListener('dom-ready', () => {
        void webviewTag
            .executeJavaScript(`
            (() => {
                if (window.__extendedBrowserPopupPatchInstalled) return;
                window.__extendedBrowserPopupPatchInstalled = true;

                const isDocumentUrl = (url) => {
                    if (!url) return false;
                    const cleanUrl = String(url).toLowerCase().split('?')[0].split('#')[0];
                    return /\\.(pdf|doc|docx|ppt|pptx|xls|xlsx)$/.test(cleanUrl);
                };

                const navigateHere = (url) => {
                    if (!url) return null;
                    window.location.href = url;
                    return null;
                };

                window.open = function(url) {
                    if (url) {
                        return navigateHere(url);
                    }

                    return null;
                };

                document.addEventListener('click', function(event) {
                    const target = event.target;
                    if (!target || !target.closest) return;

                    const link = target.closest('a[href]');
                    if (!link) return;

                    const href = link.href;
                    if (!href) return;

                    const shouldStayInside =
                        link.target === '_blank' ||
                        isDocumentUrl(href) ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey;

                    if (!shouldStayInside) return;

                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation();

                    link.target = '_self';
                    window.location.href = href;
                }, true);

                document.addEventListener('submit', function(event) {
                    const form = event.target;
                    if (!form || !form.getAttribute) return;

                    if (form.getAttribute('target') === '_blank') {
                        form.setAttribute('target', '_self');
                    }
                }, true);

                document.querySelectorAll('a[target="_blank"]').forEach((link) => {
                    link.setAttribute('target', '_self');
                });
                const observer = new MutationObserver(() => {
                    document.querySelectorAll('a[target="_blank"]').forEach((link) => {
                        link.setAttribute('target', '_self');
                    });
                });

                observer.observe(document.documentElement, {
                    childList: true,
                    subtree: true
                });
            })();
        `)
            .then(async () => {
                if (shouldAutoSignIn && !submittedAutoSignIn) {
                    submittedAutoSignIn = true
                    await webviewTag.executeJavaScript(createAutoSignInScript(params))
                    return
                }

                if (params.zoomFactor) {
                    webviewTag.setZoomFactor(params.zoomFactor)
                }

                if (params?.css) {
                    await webviewTag.insertCSS(params.css)
                }

                if (params?.js) {
                    await webviewTag.executeJavaScript(params.js)
                }

                onReady?.()
            })
            .catch((error) => {
                console.error('Extended Browser: webview dom-ready handler failed', error)
            })
    })

    return webviewTag
}

const revealLeafCompat = async (workspace: Workspace, leaf: WorkspaceLeaf): Promise<void> => {
    const revealLeaf = (workspace as Workspace & { revealLeaf?: (leaf: WorkspaceLeaf) => Promise<void> }).revealLeaf

    if (typeof revealLeaf === 'function') {
        await revealLeaf.call(workspace, leaf)
        return
    }

    workspace.setActiveLeaf(leaf, false, true)
}

export const openView = async (
    workspace: Workspace,
    id: string,
    position?: GateFrameOptionType,
    openMode: GateOpenMode = 'tab',
    context?: OpenViewContext
): Promise<WorkspaceLeaf | null> => {
    if (openMode === 'floating') {
        const gate = context?.gate
        const floatingPreview = context?.floatingPreview

        if (!gate || !floatingPreview) {
            throw new Error('Floating preview requires gate options and a floating preview manager')
        }

        const borrowableView = workspace
            .getLeavesOfType(id)
            .map((leaf) => leaf.view)
            .find((view): view is GateView => view instanceof GateView && view.canBorrowFrame())

        if (borrowableView) {
            await floatingPreview.adoptFromGateViewAndCloseTab(borrowableView)
            return null
        }

        workspace.detachLeavesOfType(id)
        await floatingPreview.show(gate)
        return null
    }

    const leafs = workspace.getLeavesOfType(id)

    if (leafs.length > 0) {
        const leaf = leafs[0]
        if (leaf.view instanceof GateView) {
            if (leaf.view.isFrameBorrowedForFloating()) {
                leaf.detach()
            } else {
                leaf.view.ensureFrame()
                await revealLeafCompat(workspace, leaf)
                return leaf
            }
        } else {
            await revealLeafCompat(workspace, leaf)
            return leaf
        }
    }

    const leaf = await createView(workspace, id, position, openMode)
    await revealLeafCompat(workspace, leaf)
    return leaf
}

export const isViewExist = (workspace: Workspace, id: string): boolean => {
    const leafs = workspace.getLeavesOfType(id)
    return leafs.length > 0
}

const createView = async (
    workspace: Workspace,
    id: string,
    position?: GateFrameOptionType,
    openMode: GateOpenMode = 'tab'
): Promise<WorkspaceLeaf> => {
    let leaf: WorkspaceLeaf | null = null

    if (openMode === 'window') {
        leaf = workspace.getLeaf('window')
    } else {
        switch (position) {
            case 'left':
                leaf = workspace.getLeftLeaf(false)
                break
            case 'center':
                leaf = workspace.getLeaf(true)
                break
            case 'right':
            default:
                leaf = workspace.getRightLeaf(false)
                break
        }
    }

    if (!leaf) {
        throw new Error(`Failed to create workspace leaf for view: ${id}`)
    }

    await leaf.setViewState({ type: id, active: true })
    return leaf
}

export const unloadView = async (
    workspace: Workspace,
    gate: GateFrameOption,
    context?: OpenViewContext
): Promise<void> => {
    workspace.detachLeavesOfType(gate.id)

    if (context?.floatingPreview?.getSourceGateId() === gate.id || context?.floatingPreview?.getCurrentGateId() === gate.id) {
        void context.floatingPreview.hide()
    }

    const ribbonIcons = workspace.containerEl.querySelector(`div[aria-label="${gate.title}"]`)
    if (ribbonIcons) {
        ribbonIcons.remove()
    }
}

export class GateView extends ItemView {
    private readonly options: GateFrameOption
    private frame?: WebviewTag | HTMLIFrameElement
    private readonly useIframe: boolean = false
    private frameReadyCallbacks: FrameReadyCallback[]
    private isFrameReady: boolean = false
    private frameDoc!: Document
    private isFrameBorrowed = false

    constructor(leaf: WorkspaceLeaf, options: GateFrameOption) {
        super(leaf)
        this.navigation = false
        this.options = options
        this.useIframe = Platform.isMobileApp
        this.frameReadyCallbacks = []
    }

    addActions(): void {
        this.addAction('arrow-left', 'Go back', () => {
            if (!this.frame) {
                return
            }

            navigateFrameBack(this.frame)
        })

        this.addAction('refresh-ccw', 'Reload', () => {
            if (!this.frame) {
                this.createFrame()
                return
            }

            if (this.frame instanceof HTMLIFrameElement) {
                this.frame.contentWindow?.location.reload()
            } else {
                this.frame.reload()
            }
        })

        this.addAction('home', 'Home page', () => {
            if (!this.frame) {
                this.createFrame()
                return
            }

            if (this.frame instanceof HTMLIFrameElement) {
                this.frame.src = this.options?.url ?? 'about:blank'
            } else {
                void this.frame.loadURL(this.options?.url ?? 'about:blank').catch((error) => {
                    console.error('Extended Browser: failed to load home page', error)
                })
            }
        })
    }

    isWebviewFrame(): boolean {
        return Boolean(this.frame) && !(this.frame instanceof HTMLIFrameElement)
    }

    private markFrameReady(): void {
        if (!this.isFrameReady) {
            this.isFrameReady = true
            this.frameReadyCallbacks.forEach((callback) => callback())
            this.frameReadyCallbacks = []
        }
    }

    private clearEmbeddedFrame(): void {
        if (this.frame) {
            this.frame.remove()
            this.frame = undefined
        }
    }

    onload(): void {
        super.onload()
        this.addActions()

        this.contentEl.empty()
        this.contentEl.addClass('extended-browser-view')

        window.setTimeout(() => {
            try {
                this.ensureFrame()
            } catch (error) {
                console.error('Extended Browser: failed to create gate frame', error)
            }
        }, 0)
    }

    ensureFrame(): void {
        this.frameDoc = this.contentEl.doc

        const restoredFrame = consumePendingFrameRestore(this.options.id)
        if (restoredFrame) {
            this.attachExternalFrame(restoredFrame)
            return
        }

        if (this.isFrameBorrowed) {
            return
        }

        const frameEl = this.frame
        if (!frameEl || !this.contentEl.contains(frameEl)) {
            this.createFrame()
        }
    }

    attachExternalFrame(frame: WebviewTag | HTMLIFrameElement): void {
        this.frame = frame
        this.isFrameBorrowed = false
        this.isFrameReady = true
        this.frameDoc = this.contentEl.doc
        applyTabFrameLayout(frame)

        if (!this.contentEl.contains(frame)) {
            this.contentEl.appendChild(frame)
        }

        if (!this.useIframe && !(frame instanceof HTMLIFrameElement)) {
            frame.addEventListener('destroyed', () => {
                window.setTimeout(() => {
                    if (this.frameDoc !== this.contentEl.doc) {
                        this.frameDoc = this.contentEl.doc
                        this.createFrame()
                    }
                }, 0)
            })
        }
    }

    private createFrame(): void {
        if (this.isFrameBorrowed) {
            return
        }

        this.clearEmbeddedFrame()
        this.isFrameReady = false

        const onReady = () => {
            this.markFrameReady()
        }

        this.frameDoc = this.contentEl.doc

        if (this.useIframe) {
            const iframe = createIframe(this.options, onReady, this.frameDoc)
            this.frame = iframe
        } else {
            const webview = createWebviewTag(this.options, onReady, this.frameDoc)
            this.frame = webview

            webview.addEventListener('destroyed', () => {
                window.setTimeout(() => {
                    if (this.frameDoc !== this.contentEl.doc) {
                        this.frameDoc = this.contentEl.doc
                        this.createFrame()
                    }
                }, 0)
            })
        }

        if (this.frame) {
            this.contentEl.appendChild(this.frame)
        }
    }

    onunload(): void {
        if (this.frame && !this.isFrameBorrowed) {
            this.frame.remove()
        }
        super.onunload()
    }

    canBorrowFrame(): boolean {
        return Boolean(this.frame) && !this.isFrameBorrowed
    }

    isFrameBorrowedForFloating(): boolean {
        return this.isFrameBorrowed
    }

    borrowFrame(): WebviewTag | HTMLIFrameElement | null {
        if (!this.canBorrowFrame()) {
            return null
        }

        this.isFrameBorrowed = true
        return this.frame ?? null
    }

    returnBorrowedFrame(): void {
        if (!this.frame || !this.isFrameBorrowed) {
            return
        }

        this.isFrameBorrowed = false
        applyTabFrameLayout(this.frame)
        this.contentEl.appendChild(this.frame)
    }

    onPaneMenu(menu: Menu, source: string): void {
        super.onPaneMenu(menu, source)
        menu.addItem((item) => {
            item.setTitle('Reload')
            item.setIcon('refresh-ccw')
            item.onClick(() => {
                if (!this.frame) {
                    this.createFrame()
                    return
                }

                if (this.frame instanceof HTMLIFrameElement) {
                    this.frame.contentWindow?.location.reload()
                } else {
                    this.frame.reload()
                }
            })
        })
        menu.addItem((item) => {
            item.setTitle('Home page')
            item.setIcon('home')
            item.onClick(() => {
                if (!this.frame) {
                    this.createFrame()
                    return
                }

                if (this.frame instanceof HTMLIFrameElement) {
                    this.frame.src = this.options?.url ?? 'about:blank'
                } else {
                    void this.frame.loadURL(this.options?.url ?? 'about:blank').catch((error) => {
                        console.error('Extended Browser: failed to load home page', error)
                    })
                }
            })
        })
        menu.addItem((item) => {
            item.setTitle('Toggle DevTools')
            item.setIcon('file-cog')
            item.onClick(() => {
                if (!this.frame || this.frame instanceof HTMLIFrameElement) {
                    return
                }

                if (this.frame.isDevToolsOpened()) {
                    this.frame.closeDevTools()
                } else {
                    this.frame.openDevTools()
                }
            })
        })

        menu.addItem((item) => {
            item.setTitle('Copy Page URL')
            item.setIcon('clipboard-copy')
            item.onClick(() => {
                if (!this.frame) {
                    clipboard.writeText(this.options.url)
                    return
                }

                if (this.frame instanceof HTMLIFrameElement) {
                    clipboard.writeText(this.frame.src)
                    return
                }

                clipboard.writeText(this.frame.getURL())
            })
        })

        menu.addItem((item) => {
            item.setTitle('Clear site session')
            item.setIcon('eraser')
            item.onClick(() => {
                void clearWebviewSession(this.options.profileKey ?? 'extended-browser').then(() => {
                    new Notice('Site session cleared. Reload the page to sign in again.')
                })
            })
        })

        menu.addItem((item) => {
            item.setTitle('Open in browser')
            item.setIcon('globe')
            item.onClick(() => {
                const url = this.getCurrentUrl()

                if (!this.frame) {
                    void shell.openExternal(url)
                    return
                }

                if (this.frame instanceof HTMLIFrameElement) {
                    void shell.openExternal(this.frame.src)
                    return
                }

                void shell.openExternal(this.frame.getURL())
            })
        })
    }

    getViewType(): string {
        return this.options?.id ?? 'gate'
    }

    getDisplayText(): string {
        return this.options?.title ?? 'Gate'
    }

    getIcon(): string {
        if (this.options?.icon.startsWith('<svg')) {
            return this.options.id
        }

        return this.options?.icon ?? 'globe'
    }

    onFrameReady(callback: FrameReadyCallback) {
        if (this.isFrameReady) {
            callback()
        } else {
            this.frameReadyCallbacks.push(callback)
        }
    }

    getCurrentUrl(): string {
        if (!this.frame) {
            return this.options.url
        }

        if (this.frame instanceof HTMLIFrameElement) {
            return this.frame.src || this.options.url
        }

        try {
            return this.frame.getURL() || this.options.url
        } catch {
            return this.options.url
        }
    }

    getSnapshot(): GateFrameOption {
        return { ...this.options, url: this.getCurrentUrl() }
    }

    async setUrl(url: string) {
        this.options.url = url

        if (!this.frame) {
            this.createFrame()
            return
        }

        if (this.frame instanceof HTMLIFrameElement) {
            this.frame.src = url
        } else {
            if (this.frame.isLoading()) {
                this.frame.stop()
            }

            await this.frame.loadURL(url)
        }
    }
}

const getOpenViewContext = (plugin: Plugin, gate: GateFrameOption): OpenViewContext | undefined => {
    const autofillPlugin = plugin as Plugin & { floatingPreview?: FloatingPreviewManager }
    if (!autofillPlugin.floatingPreview) {
        return { gate }
    }

    return {
        floatingPreview: autofillPlugin.floatingPreview,
        gate
    }
}

export const registerGate = (plugin: Plugin, options: GateFrameOption) => {
    plugin.registerView(options.id, (leaf) => {
        return new GateView(leaf, options)
    })

    let iconName = options.icon

    if (options.icon.startsWith('<svg')) {
        addIcon(options.id, options.icon)
        iconName = options.id
    }

    const openGate = () => {
        void openView(
            plugin.app.workspace,
            options.id,
            options.position,
            options.openMode ?? 'tab',
            getOpenViewContext(plugin, options)
        ).catch((error) => {
            console.error('Extended Browser: failed to open view', error)
        })
    }

    if (options.hasRibbon) {
        plugin.addRibbonIcon(iconName, options.title, openGate)
    }

    plugin.addCommand({
        id: `extended-browser-${btoa(options.url)}`,
        name: `Open ${options.title}`,
        callback: openGate
    })
}

export const createFormEditGate = (
    contentEl: HTMLElement,
    gateOptions: GateFrameOption,
    onSubmit?: (result: GateFrameOption) => void,
    submitButtonText?: string
) => {
    new Setting(contentEl)
        .setName('URL')
        .setClass('extended-browser-form-field')
        .addText((text) =>
            text
                .setPlaceholder('https://example.com')
                .setValue(gateOptions.url)
                .onChange((value) => {
                    gateOptions.url = value.trim()
                    gateOptions.loginUrl = value.trim()
                })
        )

    new Setting(contentEl)
        .setName('Name')
        .setClass('extended-browser-form-field')
        .addText((text) =>
            text.setValue(gateOptions.title).onChange((value) => {
                gateOptions.title = value
            })
        )

    new Setting(contentEl)
        .setName('Pin to menu')
        .setClass('extended-browser-form-field')
        .setDesc('If enabled, the gate will be pinned to the left bar')
        .addToggle((text) =>
            text.setValue(gateOptions.hasRibbon === true).onChange((value) => {
                gateOptions.hasRibbon = value
            })
        )
    new Setting(contentEl)
        .setName('Automatic sign-in')
        .setClass('extended-browser-form-field')
        .setDesc('If enabled, Extended Browser will submit the username and password when the page opens.')
        .addToggle((toggle) =>
            toggle.setValue(gateOptions.autoSignIn === true).onChange((value) => {
                gateOptions.autoSignIn = value
            })
        )
    new Setting(contentEl)
        .setName('Sign-in method')
        .setClass('extended-browser-form-field')
        .setDesc('Use GET if the website rejects POST with a 405 error.')
        .addDropdown((dropdown) =>
            dropdown
                .addOption('GET', 'GET')
                .addOption('POST', 'POST')
                .setValue(gateOptions.autoSignInMethod ?? 'GET')
                .onChange((value) => {
                    gateOptions.autoSignInMethod = value as GateAutoSignInMethod
                })
        )

    new Setting(contentEl)
        .setName('Open mode')
        .setClass('extended-browser-form-field')
        .setDesc('Choose whether the website opens in a tab or in a separate window.')
        .addDropdown((dropdown) =>
            dropdown
                .addOption('tab', 'Tab')
                .addOption('window', 'Window')
                .addOption('floating', 'Floating preview')
                .setValue(gateOptions.openMode ?? 'tab')
                .onChange((value) => {
                    gateOptions.openMode = value as GateOpenMode
                })
        )
    new Setting(contentEl)
        .setName('Username')
        .setClass('extended-browser-form-field')
        .addText((text) =>
            text
                .setPlaceholder('username or email')
                .setValue(gateOptions.username ?? '')
                .onChange((value) => {
                    gateOptions.username = value.trim()
                })
        )

    new Setting(contentEl)
        .setName('Password')
        .setClass('extended-browser-form-field')
        .addText((text) => {
            text.inputEl.type = 'password'
            text
                .setPlaceholder('password')
                .setValue(gateOptions.password ?? '')
                .onChange((value) => {
                    gateOptions.password = value
                })
        })

    const advancedFieldsToggle = contentEl.createDiv({
        cls: 'extended-browser-advanced-fields-toggle'
    })

    const advancedArrow = advancedFieldsToggle.createSpan({
        cls: 'extended-browser-advanced-fields-arrow',
        text: '⌄'
    })

    const advancedFieldsContainer = contentEl.createDiv({
        cls: 'extended-browser-advanced-fields-container'
    })

    advancedFieldsContainer.hide()

    let advancedFieldsOpen = false

    advancedFieldsToggle.addEventListener('click', () => {
        advancedFieldsOpen = !advancedFieldsOpen

        if (advancedFieldsOpen) {
            advancedFieldsContainer.show()
            advancedArrow.setText('⌃')
            advancedFieldsToggle.addClass('is-open')
        } else {
            advancedFieldsContainer.hide()
            advancedArrow.setText('⌄')
            advancedFieldsToggle.removeClass('is-open')
        }
    })

    new Setting(advancedFieldsContainer)
        .setName('Username field name')
        .setClass('extended-browser-form-field')
        .setDesc('Usually username, email, user, or login.')
        .addText((text) =>
            text
                .setPlaceholder('username')
                .setValue(gateOptions.usernameField ?? 'username')
                .onChange((value) => {
                    gateOptions.usernameField = value.trim() || 'username'
                })
        )

    new Setting(advancedFieldsContainer)
        .setName('Password field name')
        .setClass('extended-browser-form-field')
        .setDesc('Usually password.')
        .addText((text) =>
            text
                .setPlaceholder('password')
                .setValue(gateOptions.passwordField ?? 'password')
                .onChange((value) => {
                    gateOptions.passwordField = value.trim() || 'password'
                })
        )

    new Setting(contentEl).addButton((btn) =>
        btn
            .setButtonText(submitButtonText ?? (gateOptions.id ? 'Update passkey' : 'Create passkey'))
            .setCta()
            .onClick(() => {
                gateOptions = normalizeGateOption(gateOptions)
                onSubmit?.(gateOptions)
            })
    )
}

type CodeBlockOption = GateFrameOption & {
    height?: string | number
}

interface CodeBlockProcessorPlugin {
    findGateBy(field: 'title' | 'url', value: string): GateFrameOption | undefined
    registerMarkdownCodeBlockProcessor(
        language: string,
        handler: (source: string, el: HTMLElement, ctx: unknown) => void
    ): void
}

function processNewSyntax(plugin: CodeBlockProcessorPlugin, sourceCode: string, ownerDoc: Document): Node {
    const firstLineUrl = sourceCode.split('\n')[0]
    if (firstLineUrl.startsWith('http')) {
        sourceCode = sourceCode.replace(firstLineUrl, '').trim()
    }
    sourceCode = sourceCode.replace(/^\t+/gm, (match) => '  '.repeat(match.length))

    if (sourceCode.length === 0) {
        return createFrame(createEmptyGateOption(), '800px', ownerDoc)
    }

    let data: Partial<CodeBlockOption> = {}

    if (firstLineUrl.startsWith('http')) {
        data.url = firstLineUrl
    }

    try {
        const parsed: unknown = parse(sourceCode)
        if (!isRecord(parsed)) {
            return createErrorMessage(undefined, ownerDoc)
        }
        data = Object.assign(data, parsed)
    } catch (error) {
        return createErrorMessage(error instanceof Error ? error : undefined, ownerDoc)
    }

    if (Object.keys(data).length === 0) {
        return createErrorMessage(undefined, ownerDoc)
    }

    let height = '800px'
    if (data.height) {
        height = typeof data.height === 'number' ? `${data.height}px` : data.height
        delete data.height
    }

    let prefill: GateFrameOption | undefined

    if (data.title) {
        prefill = plugin.findGateBy('title', data.title)
    } else if (data.url) {
        prefill = plugin.findGateBy('url', data.url)
    }

    if (prefill) {
        data = Object.assign(prefill, data)
    }

    return createFrame(normalizeGateOption(data), height, ownerDoc)
}

function createErrorMessage(error?: Error, ownerDoc: Document = activeDocument): Node {
    const div = ownerDoc.createElement('div')

    const messageText = 'The syntax has been updated. Please use the YAML format.'
    div.appendChild(ownerDoc.createTextNode(messageText))

    if (error) {
        div.appendChild(ownerDoc.createTextNode(`\nError details: ${error.message}`))
    }

    div.appendChild(ownerDoc.createTextNode('\nRead more about YAML here.'))
    const linkNode = ownerDoc.createElement('a')
    linkNode.href = 'https://yaml.org/spec/1.2/spec.html'
    linkNode.textContent = 'YAML Syntax'
    div.appendChild(linkNode)

    return div
}

function createFrame(options: GateFrameOption, height: string, ownerDoc: Document = activeDocument): HTMLElement {
    if (Platform.isMobileApp) {
        const frame = createIframe(options, undefined, ownerDoc)
        frame.setCssProps({ height })
        return frame
    }

    const frame = createWebviewTag(options, undefined, ownerDoc)
    frame.setCssProps({ height })
    return frame
}

export function registerCodeBlockProcessor(plugin: CodeBlockProcessorPlugin) {
    plugin.registerMarkdownCodeBlockProcessor('gate', (sourceCode, el, _ctx) => {
        el.addClass('extended-browser-view')
        const frame = processNewSyntax(plugin, sourceCode, el.ownerDocument)
        el.appendChild(frame)
    })
}

export const setupLinkConvertMenu = (plugin: Plugin) => {
    plugin.registerEvent(plugin.app.workspace.on('editor-menu', createLinkConvertMenu))
}

const parseLink = (text: string): MarkdownLink | undefined => {
    const markdownLinkMatch = text.match(/\[([^\]]+)\]\(([^)]+)\)/)
    if (markdownLinkMatch) {
        return {
            title: markdownLinkMatch[1],
            url: markdownLinkMatch[2]
        }
    }

    const urlMatch = text.match(/https?:\/\/[^ ]+/)
    if (urlMatch) {
        return {
            title: urlMatch[0],
            url: urlMatch[0]
        }
    }
}

const createLinkConvertMenu = (menu: Menu, editor: Editor) => {
    const selection = editor.getSelection()
    if (selection.length === 0) return

    const parsedLink = parseLink(selection)
    if (!parsedLink) return

    if (
        parsedLink.url.startsWith('obsidian://extended-browser') ||
        parsedLink.url.startsWith('obsidian://urlautofill') ||
        parsedLink.url.startsWith('obsidian://opengate')
    ) {
        menu.addItem((item) => {
            item.setTitle('Convert to normal link').onClick(() => {
                const urlMatch = parsedLink.url.match(/url=([^&]+)/)
                if (!urlMatch) {
                    new Notice('Can not convert the pre-configured gate link to normal link.')
                    return
                }

                const url = decodeURIComponent(urlMatch[1])
                const normalLink = `[${parsedLink.title}](${url})`
                editor.replaceSelection(normalLink)
            })
        })
    } else {
        menu.addItem((item) => {
            item.setTitle('Convert to Gate Link').onClick(() => {
                const gateLink = `[${parsedLink.title}](obsidian://extended-browser?title=${encodeURIComponent(parsedLink.title)}&url=${encodeURIComponent(parsedLink.url)})`
                editor.replaceSelection(gateLink)
            })
        })
    }
}
