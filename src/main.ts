import { App, Notice, ObsidianProtocolData, Plugin, PluginSettingTab, Setting, SettingDefinitionItem } from 'obsidian'
import { FloatingPreviewManager } from './floating-preview'
import {
    createEmptyGateOption,
    GateView,
    normalizeGateOption,
    openView,
    registerCodeBlockProcessor,
    registerGate,
    setupLinkConvertMenu,
    unloadView
} from './functions'
import { isPartialGateOption, isRecord, isString } from './guards'
import { FirstPasskey, ModalEditGate, ModalListGates, setupInsertLinkMenu } from './passkeys'
import { GateFrameOption, GateFrameOptionType, PluginSetting } from './types'

const DEFAULT_SETTINGS: PluginSetting = {
    uuid: '',
    gates: {}
}

class SettingTab extends PluginSettingTab {
    plugin: ExtendedBrowserPlugin

    constructor(app: App, plugin: ExtendedBrowserPlugin) {
        super(app, plugin)
        this.plugin = plugin
    }

    async updateGate(gate: GateFrameOption) {
        await this.plugin.addGate(gate)
        this.refreshTab()
    }

    private refreshTab(): void {
        this.update()
    }

    getSettingDefinitions(): SettingDefinitionItem[] {
        const gates = Object.values(this.plugin.settings.gates)

        return [
            {
                type: 'list',
                heading: 'Passkeys',
                emptyState: 'No passkeys configured yet.',
                addItem: {
                    name: 'New passkey',
                    action: () => {
                        new ModalEditGate(this.app, createEmptyGateOption(), (updatedGate) => {
                            void this.updateGate(updatedGate)
                        }).open()
                    }
                },
                items: gates.map((gate) => ({
                    name: gate.title,
                    desc: gate.url,
                    render: (setting: Setting) => {
                        setting.settingEl.setAttribute('data-gate-id', gate.id)
                        setting.settingEl.addClass('extended-browser-setting-gate')
                        setting.addButton((button) =>
                            button.setButtonText('Edit').onClick(() => {
                                new ModalEditGate(this.app, gate, (updatedGate) => {
                                    void this.updateGate(updatedGate)
                                }).open()
                            })
                        )
                        setting.addButton((button) =>
                            button.setButtonText('Delete').onClick(() => {
                                void this.plugin.removeGate(gate.id).then(() => {
                                    this.refreshTab()
                                })
                            })
                        )
                    }
                }))
            }
        ]
    }
}

export default class ExtendedBrowserPlugin extends Plugin {
    settings: PluginSetting
    floatingPreview: FloatingPreviewManager
    private lastGateView: GateView | null = null

    async onload() {
        await this.loadSettings()
        this.floatingPreview = new FloatingPreviewManager(
            (gate) => this.restoreGateToTab(gate),
            (gateId) => this.app.workspace.detachLeavesOfType(gateId)
        )
        this.addSettingTab(new SettingTab(this.app, this))
        await this.mayShowFirstPasskey()
        await this.initGates()
        this.registerCommands()
        this.registerProtocol()
        setupLinkConvertMenu(this)
        setupInsertLinkMenu(this)
        registerCodeBlockProcessor(this)

        this.registerEvent(
            this.app.workspace.on('active-leaf-change', (leaf) => {
                if (leaf?.view instanceof GateView) {
                    this.lastGateView = leaf.view
                }
            })
        )
    }

    onunload() {
        this.floatingPreview.destroy()
    }

    private getOpenViewContext(gate: GateFrameOption) {
        return {
            floatingPreview: this.floatingPreview,
            gate
        }
    }

    private collectOpenGateViews(): GateView[] {
        const views: GateView[] = []

        for (const gate of Object.values(this.settings.gates)) {
            for (const leaf of this.app.workspace.getLeavesOfType(gate.id)) {
                if (leaf.view instanceof GateView) {
                    views.push(leaf.view)
                }
            }
        }

        for (const leaf of this.app.workspace.getLeavesOfType('temp-gate')) {
            if (leaf.view instanceof GateView) {
                views.push(leaf.view)
            }
        }

        return views
    }

    private findTargetGateView(): GateView | null {
        const activeView = this.app.workspace.getActiveViewOfType(GateView)
        if (activeView) {
            return activeView
        }

        if (this.lastGateView?.leaf && this.lastGateView.leaf.view === this.lastGateView) {
            return this.lastGateView
        }

        const openViews = this.collectOpenGateViews()
        if (openViews.length === 0) {
            return null
        }

        const borrowableViews = openViews.filter((view) => view.canBorrowFrame())
        if (borrowableViews.length > 0) {
            return borrowableViews[0]
        }

        return openViews[0]
    }

    async restoreGateToTab(gate: GateFrameOption) {
        return openView(this.app.workspace, gate.id, gate.position, 'tab', this.getOpenViewContext(gate))
    }

    private async toggleFloatingPreview() {
        if (this.floatingPreview.isVisible()) {
            if (this.floatingPreview.hasBorrowedFrame()) {
                await this.floatingPreview.restoreToTab()
            } else {
                await this.floatingPreview.hide()
            }
            return
        }

        const gateView = this.findTargetGateView()
        if (gateView) {
            await this.floatingPreview.adoptFromGateViewAndCloseTab(gateView)
            return
        }

        const gate =
            Object.values(this.settings.gates)[0] ??
            normalizeGateOption({
                id: 'temp-gate',
                title: 'Temp Gate',
                icon: 'globe',
                url: 'about:blank'
            })

        void this.floatingPreview.show(gate)
    }

    async mayShowFirstPasskey() {
        if (this.settings.uuid === '') {
            this.settings.uuid = this.generateUuid()
            await this.saveSettings()

            if (Object.keys(this.settings.gates).length === 0) {
                new FirstPasskey(this.app, createEmptyGateOption(), (gate: GateFrameOption) => {
                    void this.addGate(gate).catch((error) => {
                        console.error('Extended Browser: failed to save first passkey', error)
                    })
                }).open()
            }
        }
    }

    private async initGates() {
        for (const gateId in this.settings.gates) {
            const gate = this.settings.gates[gateId]
            registerGate(this, gate)
        }

        registerGate(
            this,
            normalizeGateOption({
                id: 'temp-gate',
                title: 'Temp Gate',
                icon: 'globe',
                url: 'about:blank'
            })
        )
    }

    private registerCommands() {
        this.addCommand({
            id: `extended-browser-create-new`,
            name: `Create new site`,
            callback: () => {
                new ModalEditGate(this.app, createEmptyGateOption(), (gate: GateFrameOption) => {
                    void this.addGate(gate).catch((error) => {
                        console.error('Extended Browser: failed to create site', error)
                    })
                }).open()
            }
        })

        this.addCommand({
            id: `extended-browser-list-gates`,
            name: `List sites`,
            callback: () => {
                new ModalListGates(
                    this.app,
                    this.settings.gates,
                    (gate: GateFrameOption) => {
                        void this.addGate(gate).catch((error) => {
                            console.error('Extended Browser: failed to add site from list', error)
                        })
                    },
                    (gate) => this.getOpenViewContext(gate)
                ).open()
            }
        })

        this.addCommand({
            id: `extended-browser-toggle-floating-preview`,
            name: `Toggle floating preview`,
            callback: () => {
                void this.toggleFloatingPreview()
            }
        })
    }

    private registerProtocol() {
        const handleProtocol = (data: ObsidianProtocolData) => {
            void this.handleCustomProtocol(data).catch((error) => {
                console.error('Extended Browser: protocol handler failed', error)
            })
        }

        this.registerObsidianProtocolHandler('extended-browser', handleProtocol)
        this.registerObsidianProtocolHandler('urlautofill', handleProtocol)
    }

    getGateOptionFromProtocolData(data: ObsidianProtocolData): GateFrameOption | undefined {
        const { title, url, id, position } = data

        let targetGate: GateFrameOption | undefined

        if (id && this.settings.gates[id]) {
            targetGate = this.settings.gates[id]
        } else {
            targetGate = Object.values(this.settings.gates).find(
                (gate) => (title && gate.title.toLowerCase() === title.toLowerCase()) || (url && gate.url.toLowerCase() === url.toLowerCase())
            )
        }

        if (!targetGate) {
            targetGate = createEmptyGateOption()
        }

        if (url) {
            targetGate.url = url
        }

        if (position) {
            targetGate.position = position as GateFrameOptionType
        }

        return targetGate
    }

    findGateBy(field: 'title' | 'url', value: string): GateFrameOption | undefined {
        return Object.values(this.settings.gates).find((gate) => gate[field].toLowerCase() === value.toLowerCase())
    }

    async handleCustomProtocol(data: ObsidianProtocolData) {
        const targetGate = this.getGateOptionFromProtocolData(data)
        if (targetGate === undefined) {
            if (!data.url) {
                new Notice('Missing url parameter')
                return
            }
        }

        const openMode = targetGate?.openMode ?? 'tab'
        const url = data.url ?? targetGate?.url ?? 'about:blank'

        if (openMode === 'floating' && targetGate) {
            const borrowableView = this.app.workspace
                .getLeavesOfType(targetGate.id)
                .map((leaf) => leaf.view)
                .find((view): view is GateView => view instanceof GateView && view.canBorrowFrame())

            if (borrowableView) {
                await this.floatingPreview.adoptFromGateViewAndCloseTab(borrowableView)
            } else {
                this.app.workspace.detachLeavesOfType(targetGate.id)
                await this.floatingPreview.show(targetGate)
            }

            this.floatingPreview.onFrameReady(() => {
                if (!this.floatingPreview.getSourceGateId()) {
                    void this.floatingPreview.setUrl(url).catch((error) => {
                        console.error('Extended Browser: failed to set URL from protocol handler', error)
                    })
                }
            })
            return
        }

        const leaf = await openView(
            this.app.workspace,
            targetGate?.id || 'temp-gate',
            targetGate?.position,
            openMode,
            targetGate ? this.getOpenViewContext(targetGate) : undefined
        )

        if (!leaf) {
            return
        }

        const gateView = leaf.view as GateView
        gateView?.onFrameReady(() => {
            void gateView.setUrl(url).catch((error) => {
                console.error('Extended Browser: failed to set URL from protocol handler', error)
            })
        })
    }

    async addGate(gate: GateFrameOption) {
        const normalizedGate = normalizeGateOption(gate)

        if (!Object.prototype.hasOwnProperty.call(this.settings.gates, normalizedGate.id)) {
            registerGate(this, normalizedGate)
        } else {
            new Notice('This change will take effect after you reload Obsidian.')
        }

        this.settings.gates[normalizedGate.id] = normalizedGate

        await this.saveSettings()
    }

    async removeGate(gateId: string) {
        if (!this.settings.gates[gateId]) {
            new Notice('Gate not found')
            return
        }

        const gate = this.settings.gates[gateId]

        await unloadView(this.app.workspace, gate, this.getOpenViewContext(gate))
        delete this.settings.gates[gateId]
        await this.saveSettings()
        new Notice('This change will take effect after you reload Obsidian.')
    }

    async loadSettings() {
        const loaded: unknown = await this.loadData()
        const partial = isRecord(loaded) ? loaded : {}

        this.settings = {
            uuid: isString(partial.uuid) ? partial.uuid : DEFAULT_SETTINGS.uuid,
            gates: {}
        }

        if (isRecord(partial.gates)) {
            for (const gateId in partial.gates) {
                const gateValue = partial.gates[gateId]
                if (isPartialGateOption(gateValue)) {
                    try {
                        this.settings.gates[gateId] = normalizeGateOption(gateValue)
                    } catch (error) {
                        console.error(`Extended Browser: skipped invalid passkey "${gateId}"`, error)
                    }
                }
            }
        }
    }

    async saveSettings() {
        await this.saveData(this.settings)
    }

    private generateUuid() {
        return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
    }
}
