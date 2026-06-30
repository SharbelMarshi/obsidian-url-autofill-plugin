import WebviewTag = Electron.WebviewTag
import { Platform, setIcon, WorkspaceLeaf } from 'obsidian'
import {
    applyFloatingFrameLayout,
    createIframe,
    createWebviewTag,
    GateView,
    navigateFrameBack,
    resizeFloatingFrame,
    setPendingFrameRestore,
    startWebviewNavigation
} from './functions'
import { GateFrameOption } from './types'

type FrameReadyCallback = () => void
type RestoreTabCallback = (gate: GateFrameOption) => Promise<WorkspaceLeaf | null>
type CloseGateLeavesCallback = (gateId: string) => void
type ResizeEdge = 'e' | 's' | 'se'

export const FLOATING_PREVIEW_WIDTH = 416
export const FLOATING_PREVIEW_HEIGHT = 358
export const FLOATING_PREVIEW_HEADER_HEIGHT = 36
export const FLOATING_PREVIEW_MIN_WIDTH = 280
export const FLOATING_PREVIEW_MIN_HEIGHT = 200

export class FloatingPreviewManager {
    private rootEl: HTMLElement | null = null
    private frameHostEl: HTMLElement | null = null
    private titleEl: HTMLElement | null = null
    private frame: WebviewTag | HTMLIFrameElement | null = null
    private currentGate: GateFrameOption | null = null
    private borrowedFrame = false
    private frameReadyCallbacks: FrameReadyCallback[] = []
    private isFrameReady = false
    private panelWidth = FLOATING_PREVIEW_WIDTH
    private panelHeight = FLOATING_PREVIEW_HEIGHT
    private backBtn: HTMLButtonElement | null = null
    private detachNavigationListeners: (() => void) | null = null

    constructor(
        private readonly restoreTab: RestoreTabCallback,
        private readonly closeGateLeaves: CloseGateLeavesCallback
    ) {}

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

        await this.waitForGateFrame(gateView)
        const snapshot = gateView.getSnapshot()
        const frame = gateView.borrowFrame()

        if (!frame) {
            this.closeGateLeaves(snapshot.id)
            await this.show(snapshot, snapshot.url)
            return
        }

        if (!this.rootEl) {
            this.createRoot()
        }

        this.borrowedFrame = true
        this.setFrame(frame)
        this.currentGate = snapshot
        this.isFrameReady = true
        this.frameReadyCallbacks = []

        this.rootEl!.classList.remove('is-hidden')
        this.updateTitle(gateView.getDisplayText())

        if (this.frameHostEl) {
            this.frameHostEl.empty()
            const layout = this.getFrameLayout()
            resizeFloatingFrame(frame, layout.width, layout.height)
            this.frameHostEl.appendChild(frame)
        }

        this.applyPanelSize()
        this.closeGateLeaves(snapshot.id)
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
        this.setFrame(null)
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
        this.backBtn = null
        this.detachFrameNavigationListeners()
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
        this.rootEl = activeDocument.body.createDiv({ cls: 'extended-browser-floating-preview is-hidden' })

        const toolbarZone = this.rootEl.createDiv({ cls: 'extended-browser-floating-preview-toolbar-zone' })
        const header = toolbarZone.createDiv({ cls: 'extended-browser-floating-preview-header' })
        this.titleEl = header.createDiv({ cls: 'extended-browser-floating-preview-title' })

        const actions = header.createDiv({ cls: 'extended-browser-floating-preview-actions' })

        this.backBtn = actions.createEl('button', {
            cls: 'clickable-icon',
            attr: { 'aria-label': 'Go back', type: 'button' }
        })
        setIcon(this.backBtn, 'arrow-left')
        this.backBtn.addEventListener('mousedown', (event) => {
            event.preventDefault()
            navigateFrameBack(this.frame)
        })

        const reloadBtn = actions.createEl('button', {
            cls: 'clickable-icon',
            attr: { 'aria-label': 'Reload', type: 'button' }
        })
        setIcon(reloadBtn, 'refresh-ccw')
        reloadBtn.addEventListener('mousedown', (event) => {
            event.preventDefault()
            this.reload()
        })

        const closeBtn = actions.createEl('button', {
            cls: 'clickable-icon',
            attr: { 'aria-label': 'Close', type: 'button' }
        })
        setIcon(closeBtn, 'cross')
        closeBtn.addEventListener('click', () => {
            void this.hide()
        })

        this.frameHostEl = this.rootEl.createDiv({ cls: 'extended-browser-floating-preview-content' })
        this.setupDragging(header)
        this.setupResizing()
        this.applyPanelSize()
    }

    private setupDragging(header: HTMLElement): void {
        let dragging = false
        let startX = 0
        let startY = 0
        let startLeft = 0
        let startTop = 0

        const onPointerMove = (event: PointerEvent): void => {
            if (!dragging || !this.rootEl) {
                return
            }

            const dx = event.clientX - startX
            const dy = event.clientY - startY
            this.rootEl.setCssProps({
                left: `${startLeft + dx}px`,
                top: `${startTop + dy}px`,
                right: 'auto'
            })
        }

        const onPointerUp = (event: PointerEvent): void => {
            if (!dragging) {
                return
            }

            dragging = false
            header.releasePointerCapture(event.pointerId)
            activeDocument.removeEventListener('pointermove', onPointerMove)
            activeDocument.removeEventListener('pointerup', onPointerUp)
            header.classList.remove('is-dragging')
        }

        header.addEventListener('pointerdown', (event: PointerEvent) => {
            if (!this.rootEl || event.button !== 0) {
                return
            }

            const target = event.target as HTMLElement
            if (target.closest('button') || target.closest('.extended-browser-floating-preview-resize')) {
                return
            }

            dragging = true
            const rect = this.rootEl.getBoundingClientRect()
            startX = event.clientX
            startY = event.clientY
            startLeft = rect.left
            startTop = rect.top
            this.rootEl.setCssProps({
                left: `${startLeft}px`,
                top: `${startTop}px`,
                right: 'auto'
            })
            header.setPointerCapture(event.pointerId)
            header.classList.add('is-dragging')
            activeDocument.addEventListener('pointermove', onPointerMove)
            activeDocument.addEventListener('pointerup', onPointerUp)
        })
    }

    private setupResizing(): void {
        if (!this.rootEl) {
            return
        }

        const edges: ResizeEdge[] = ['e', 's', 'se']
        for (const edge of edges) {
            const handle = this.rootEl.createDiv({
                cls: `extended-browser-floating-preview-resize extended-browser-floating-preview-resize-${edge}`
            })
            this.bindResizeHandle(handle, edge)
        }
    }

    private bindResizeHandle(handle: HTMLElement, edge: ResizeEdge): void {
        let resizing = false
        let startX = 0
        let startY = 0
        let startWidth = 0
        let startHeight = 0

        const onPointerMove = (event: PointerEvent): void => {
            if (!resizing) {
                return
            }

            const dx = event.clientX - startX
            const dy = event.clientY - startY

            if (edge === 'e' || edge === 'se') {
                this.panelWidth = Math.max(FLOATING_PREVIEW_MIN_WIDTH, startWidth + dx)
            }

            if (edge === 's' || edge === 'se') {
                this.panelHeight = Math.max(FLOATING_PREVIEW_MIN_HEIGHT, startHeight + dy)
            }

            this.applyPanelSize()
        }

        const onPointerUp = (event: PointerEvent): void => {
            if (!resizing) {
                return
            }

            resizing = false
            handle.releasePointerCapture(event.pointerId)
            activeDocument.removeEventListener('pointermove', onPointerMove)
            activeDocument.removeEventListener('pointerup', onPointerUp)
            handle.classList.remove('is-resizing')
        }

        handle.addEventListener('pointerdown', (event: PointerEvent) => {
            if (event.button !== 0) {
                return
            }

            event.preventDefault()
            event.stopPropagation()

            resizing = true
            startX = event.clientX
            startY = event.clientY
            startWidth = this.panelWidth
            startHeight = this.panelHeight
            handle.setPointerCapture(event.pointerId)
            handle.classList.add('is-resizing')
            activeDocument.addEventListener('pointermove', onPointerMove)
            activeDocument.addEventListener('pointerup', onPointerUp)
        })
    }

    private applyPanelSize(): void {
        if (!this.rootEl || !this.frameHostEl) {
            return
        }

        const layout = this.getFrameLayout()
        this.rootEl.setCssProps({
            width: `${this.panelWidth}px`,
            height: `${this.panelHeight}px`
        })
        this.frameHostEl.setCssProps({
            height: `${layout.height}px`
        })

        if (this.frame) {
            resizeFloatingFrame(this.frame, layout.width, layout.height)
        }
    }

    private setFrame(frame: WebviewTag | HTMLIFrameElement | null): void {
        this.detachFrameNavigationListeners()
        this.frame = frame

        if (frame) {
            this.attachFrameNavigationListeners(frame)
        } else {
            this.updateBackButtonState()
        }
    }

    private async waitForGateFrame(gateView: GateView): Promise<void> {
        gateView.ensureFrame()
        await new Promise<void>((resolve) => {
            gateView.onFrameReady(() => resolve())
        })
    }

    private getFrameLayout(): { width: number; height: number } {
        const width = this.panelWidth - 2
        const height = this.panelHeight - 2
        return { width, height }
    }

    private canFrameGoBack(): boolean {
        if (!this.frame) {
            return false
        }

        if (this.frame instanceof HTMLIFrameElement) {
            try {
                return (this.frame.contentWindow?.history.length ?? 0) > 1
            } catch {
                return false
            }
        }

        return this.frame.canGoBack()
    }

    private updateBackButtonState(): void {
        if (!this.backBtn) {
            return
        }

        const canGoBack = this.canFrameGoBack()
        this.backBtn.toggleClass('is-disabled', !canGoBack)
        this.backBtn.setAttr('aria-disabled', canGoBack ? 'false' : 'true')
    }

    private attachFrameNavigationListeners(frame: WebviewTag | HTMLIFrameElement): void {
        this.detachFrameNavigationListeners()

        const updateBackButton = (): void => {
            this.updateBackButtonState()
        }

        if (frame instanceof HTMLIFrameElement) {
            frame.addEventListener('load', updateBackButton)
            this.detachNavigationListeners = () => {
                frame.removeEventListener('load', updateBackButton)
            }
        } else {
            frame.addEventListener('did-navigate', updateBackButton)
            frame.addEventListener('did-navigate-in-page', updateBackButton)
            frame.addEventListener('did-frame-navigate', updateBackButton)
            this.detachNavigationListeners = () => {
                frame.removeEventListener('did-navigate', updateBackButton)
                frame.removeEventListener('did-navigate-in-page', updateBackButton)
                frame.removeEventListener('did-frame-navigate', updateBackButton)
            }
        }

        updateBackButton()
    }

    private detachFrameNavigationListeners(): void {
        this.detachNavigationListeners?.()
        this.detachNavigationListeners = null
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

        this.setFrame(null)
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

            this.setFrame(iframe)
            applyFloatingFrameLayout(iframe, layout.width, layout.height)
            this.frameHostEl.appendChild(iframe)
            this.applyPanelSize()
            return
        }

        const webview = createWebviewTag(
            gate,
            onReady,
            activeDocument,
            {
                width: layout.width,
                height: layout.height,
                deferSrc: true
            }
        )

        if (!webview) {
            return
        }

        this.setFrame(webview)
        this.frameHostEl.appendChild(webview)
        startWebviewNavigation(webview, gate)
        this.applyPanelSize()
    }
}
