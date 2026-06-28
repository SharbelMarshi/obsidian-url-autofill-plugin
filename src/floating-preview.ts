import WebviewTag = Electron.WebviewTag
import { Platform, setIcon, WorkspaceLeaf } from 'obsidian'
import {
    applyFloatingFrameLayout,
    createIframe,
    createWebviewTag,
    GateView,
    setPendingFrameRestore,
    startWebviewNavigation
} from './functions'
import { GateFrameOption } from './types'

type FrameReadyCallback = () => void
type RestoreTabCallback = (gate: GateFrameOption) => Promise<WorkspaceLeaf | null>

export const FLOATING_PREVIEW_WIDTH = 420
export const FLOATING_PREVIEW_HEIGHT = 360
export const FLOATING_PREVIEW_CONTENT_HEIGHT = 324

export class FloatingPreviewManager {
    private rootEl: HTMLElement | null = null
    private frameHostEl: HTMLElement | null = null
    private titleEl: HTMLElement | null = null
    private frame: WebviewTag | HTMLIFrameElement | null = null
    private currentGate: GateFrameOption | null = null
    private borrowedFrame = false
    private frameReadyCallbacks: FrameReadyCallback[] = []
    private isFrameReady = false

    constructor(private readonly restoreTab: RestoreTabCallback) {}

    isVisible(): boolean {
        return this.rootEl !== null && !this.rootEl.classList.contains('is-hidden')
    }

    hasBorrowedFrame(): boolean {
        return this.borrowedFrame
    }

    getCurrentGateId(): string | null {
        return this.currentGate?.id ?? null
    }

    getSourceGateId(): string | null {
        return this.currentGate?.id ?? null
    }

    async showCustomContent(title: string, build: (host: HTMLElement) => void | Promise<void>): Promise<void> {
        if (this.borrowedFrame) {
            await this.restoreToTab()
        }

        if (!this.rootEl) {
            this.createRoot()
        }

        this.currentGate = null
        this.rootEl!.classList.remove('is-hidden')
        this.updateTitle(title)
        this.clearCreatedFrame()

        if (this.frameHostEl) {
            await build(this.frameHostEl)
        }

        this.isFrameReady = true
        this.frameReadyCallbacks.forEach((callback) => callback())
        this.frameReadyCallbacks = []
    }

    async adoptFromGateViewAndCloseTab(gateView: GateView): Promise<void> {
        if (this.isVisible()) {
            await this.restoreToTab()
        }

        const frame = gateView.borrowFrame()
        const snapshot = gateView.getSnapshot()

        if (!frame) {
            gateView.leaf.detach()
            await this.show(snapshot, snapshot.url)
            return
        }

        if (!this.rootEl) {
            this.createRoot()
        }

        this.borrowedFrame = true
        this.frame = frame
        this.currentGate = snapshot
        this.isFrameReady = true
        this.frameReadyCallbacks = []

        this.rootEl!.classList.remove('is-hidden')
        this.updateTitle(gateView.getDisplayText())

        if (this.frameHostEl) {
            this.frameHostEl.empty()
            const layout = this.getFrameLayout()
            applyFloatingFrameLayout(frame as unknown as HTMLElement, layout.width, layout.height)
            this.frameHostEl.appendChild(frame as unknown as HTMLElement)
        }

        gateView.leaf.detach()
    }

    async show(gate: GateFrameOption, navigatedUrl?: string): Promise<void> {
        if (this.borrowedFrame) {
            await this.restoreToTab()
        }

        const displayUrl = navigatedUrl ?? gate.url
        const gateForFrame: GateFrameOption = { ...gate, url: displayUrl }

        if (!this.rootEl) {
            this.createRoot()
        }

        this.currentGate = gateForFrame
        this.rootEl!.classList.remove('is-hidden')
        this.updateTitle(gate.title)

        this.rebuildFrame(gateForFrame)
    }

    async hide(): Promise<void> {
        if (this.borrowedFrame && this.currentGate) {
            await this.restoreToTab()
            return
        }

        this.hideWithoutRestore()
    }

    async restoreToTab(): Promise<void> {
        if (!this.borrowedFrame || !this.frame || !this.currentGate) {
            this.hideWithoutRestore()
            return
        }

        const gate = { ...this.currentGate }
        const frame = this.frame
        const gateId = gate.id

        this.rootEl?.classList.add('is-hidden')
        if (this.frameHostEl) {
            this.frameHostEl.empty()
        }

        setPendingFrameRestore(gateId, frame)
        this.borrowedFrame = false
        this.frame = null
        this.isFrameReady = false
        this.frameReadyCallbacks = []

        await this.restoreTab(gate)
    }

    toggle(gate?: GateFrameOption, navigatedUrl?: string): void {
        if (this.isVisible()) {
            void this.hide()
            return
        }

        const target = gate ?? this.currentGate
        if (target) {
            void this.show(target, navigatedUrl)
        }
    }

    onFrameReady(callback: FrameReadyCallback): void {
        if (this.isFrameReady) {
            callback()
        } else {
            this.frameReadyCallbacks.push(callback)
        }
    }

    async setUrl(url: string): Promise<void> {
        if (this.currentGate) {
            this.currentGate = { ...this.currentGate, url }
        }

        if (!this.frame) {
            if (this.currentGate) {
                await this.show({ ...this.currentGate, url }, url)
            }
            return
        }

        if (this.frame instanceof HTMLIFrameElement) {
            this.frame.src = url
            return
        }

        if (this.frame.isLoading()) {
            this.frame.stop()
        }

        await this.frame.loadURL(url)
    }

    destroy(): void {
        this.borrowedFrame = false
        this.clearCreatedFrame()

        if (this.rootEl) {
            this.rootEl.remove()
        }

        this.rootEl = null
        this.frameHostEl = null
        this.titleEl = null
        this.frame = null
        this.currentGate = null
        this.frameReadyCallbacks = []
        this.isFrameReady = false
    }

    private hideWithoutRestore(): void {
        if (this.rootEl) {
            this.rootEl.classList.add('is-hidden')
        }

        this.clearCreatedFrame()
    }

    private createRoot(): void {
        this.rootEl = document.body.createDiv({ cls: 'extended-browser-floating-preview is-hidden' })

        const header = this.rootEl.createDiv({ cls: 'extended-browser-floating-preview-header' })
        this.titleEl = header.createDiv({ cls: 'extended-browser-floating-preview-title' })

        const actions = header.createDiv({ cls: 'extended-browser-floating-preview-actions' })

        const reloadBtn = actions.createEl('button', {
            cls: 'clickable-icon',
            attr: { 'aria-label': 'Reload', type: 'button' }
        })
        setIcon(reloadBtn, 'refresh-ccw')
        reloadBtn.addEventListener('click', () => this.reload())

        const closeBtn = actions.createEl('button', {
            cls: 'clickable-icon',
            attr: { 'aria-label': 'Close', type: 'button' }
        })
        setIcon(closeBtn, 'cross')
        closeBtn.addEventListener('click', () => {
            void this.hide()
        })

        this.frameHostEl = this.rootEl.createDiv({ cls: 'extended-browser-floating-preview-content' })
    }

    private getFrameLayout(): { width: number; height: number } {
        const width = FLOATING_PREVIEW_WIDTH - 2
        const height = FLOATING_PREVIEW_CONTENT_HEIGHT
        return { width, height }
    }

    private updateTitle(title: string): void {
        if (this.titleEl) {
            this.titleEl.setText(title)
        }
    }

    private reload(): void {
        if (!this.frame) {
            if (this.currentGate) {
                this.rebuildFrame(this.currentGate)
            }
            return
        }

        if (this.frame instanceof HTMLIFrameElement) {
            this.frame.contentWindow?.location.reload()
            return
        }

        this.frame.reload()
    }

    private clearCreatedFrame(): void {
        if (this.borrowedFrame) {
            return
        }

        if (this.frame) {
            this.frame.remove()
        }

        this.frame = null
        this.isFrameReady = false
        this.frameReadyCallbacks = []

        if (this.frameHostEl) {
            this.frameHostEl.empty()
        }
    }

    private rebuildFrame(gate: GateFrameOption): void {
        if (!this.frameHostEl) {
            return
        }

        this.clearCreatedFrame()

        const layout = this.getFrameLayout()

        const onReady = () => {
            if (!this.isFrameReady) {
                this.isFrameReady = true
                this.frameReadyCallbacks.forEach((callback) => callback())
                this.frameReadyCallbacks = []
            }
        }

        if (Platform.isMobileApp) {
            const iframe = createIframe(gate, onReady, this.frameHostEl.ownerDocument)
            if (!iframe) {
                return
            }

            this.frame = iframe
            applyFloatingFrameLayout(this.frame as unknown as HTMLElement, layout.width, layout.height)
            this.frameHostEl.appendChild(this.frame as unknown as HTMLElement)
            return
        }

        const webview = createWebviewTag(
            gate,
            onReady,
            document,
            {
                width: layout.width,
                height: layout.height,
                deferSrc: true
            }
        )

        if (!webview) {
            return
        }

        this.frame = webview
        this.frameHostEl.appendChild(webview as unknown as HTMLElement)
        startWebviewNavigation(webview, gate)
    }
}
