import { App, Notice, ObsidianProtocolData, Plugin, PluginSettingTab, Setting, SettingDefinitionItem } from 'obsidian'
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
import { isRecord, isString } from './guards'
import { FirstPasskey, ModalEditGate, ModalListGates, setupInsertLinkMenu } from './passkeys'
import { GateFrameOption, GateFrameOptionType, PluginSetting } from './types'

const DEFAULT_SETTINGS: PluginSetting = {
    uuid: '',
    gates: {}
}

class SettingTab extends PluginSettingTab {
    plugin: URLAutoFillPlugin

    constructor(app: App, plugin: URLAutoFillPlugin) {
        super(app, plugin)
        this.plugin = plugin
    }

    async updateGate(gate: GateFrameOption) {
        await this.plugin.addGate(gate)
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
                        setting.settingEl.addClass('urlautofill-setting-gate')
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
                                    this.update()
                                })
                            })
                        )
                    }
                }))
            }
        ]
    }
}

export default class URLAutoFillPlugin extends Plugin {
    settings: PluginSetting

    async onload() {
        await this.loadSettings()
        await this.mayShowFirstPasskey()
        await this.initGates()
        this.addSettingTab(new SettingTab(this.app, this))
        this.registerCommands()
        this.registerProtocol()
        setupLinkConvertMenu(this)
        setupInsertLinkMenu(this)
        registerCodeBlockProcessor(this)
    }

    async mayShowFirstPasskey() {
        if (this.settings.uuid === '') {
            this.settings.uuid = this.generateUuid()
            await this.saveSettings()

            if (Object.keys(this.settings.gates).length === 0) {
                new FirstPasskey(this.app, createEmptyGateOption(), (gate: GateFrameOption) => {
                    void this.addGate(gate).catch((error) => {
                        console.error('URLAutoFill: failed to save first passkey', error)
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
            id: `url-autofill-create-new`,
            name: `Create new site`,
            callback: () => {
                new ModalEditGate(this.app, createEmptyGateOption(), (gate: GateFrameOption) => {
                    void this.addGate(gate).catch((error) => {
                        console.error('URLAutoFill: failed to create site', error)
                    })
                }).open()
            }
        })

        this.addCommand({
            id: `url-autofill-list-gates`,
            name: `List sites`,
            callback: () => {
                new ModalListGates(this.app, this.settings.gates, (gate: GateFrameOption) => {
                    void this.addGate(gate).catch((error) => {
                        console.error('URLAutoFill: failed to add site from list', error)
                    })
                }).open()
            }
        })
    }

    private registerProtocol() {
        this.registerObsidianProtocolHandler('urlautofill', (data) => {
            void this.handleCustomProtocol(data).catch((error) => {
                console.error('URLAutoFill: protocol handler failed', error)
            })
        })
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

        const gate = await openView(
            this.app.workspace,
            targetGate?.id || 'temp-gate',
            targetGate?.position,
            targetGate?.openMode ?? 'tab'
        )
        const gateView = gate.view as GateView
        gateView?.onFrameReady(() => {
            void gateView.setUrl(data.url ?? targetGate?.url ?? 'about:blank').catch((error) => {
                console.error('URLAutoFill: failed to set URL from protocol handler', error)
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

        await unloadView(this.app.workspace, gate)
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
                if (isRecord(gateValue) && isString(gateValue.url)) {
                    try {
                        this.settings.gates[gateId] = normalizeGateOption(gateValue as Partial<GateFrameOption>)
                    } catch (error) {
                        console.error(`URLAutoFill: skipped invalid passkey "${gateId}"`, error)
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
