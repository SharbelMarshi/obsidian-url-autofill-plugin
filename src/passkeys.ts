import { App, Editor, getIcon, Menu, Modal, Setting } from 'obsidian'
import { createEmptyGateOption, createFormEditGate, normalizeGateOption, openView, OpenViewContext } from './functions'
import { GateFrameOption } from './types'

const appendSvgIcon = (container: HTMLElement, iconMarkup: string) => {
    const parsed = new DOMParser().parseFromString(iconMarkup, 'image/svg+xml')
    const svgNode = container.ownerDocument.importNode(parsed.documentElement, true)
    svgNode.classList.add('svg-icon')
    container.appendChild(svgNode)
}

export class FirstPasskey extends Modal {
    gateOptions: GateFrameOption
    onSubmit: (result: GateFrameOption) => void

    constructor(app: App, gateOptions: GateFrameOption, onSubmit: (result: GateFrameOption) => void) {
        super(app)
        this.onSubmit = onSubmit
        this.gateOptions = gateOptions
    }

    onOpen() {
        const { contentEl } = this

        this.modalEl.addClass('extended-browser-passkey-modal')
        this.titleEl.setText('Welcome, Create your first passkey !')

        createFormEditGate(contentEl, this.gateOptions, (result) => {
            this.onSubmit(result)
            this.close()
        }, 'Create passkey')
    }
    onClose() {
        this.contentEl.empty()
    }
}

export class ModalEditGate extends Modal {
    gateOptions: GateFrameOption
    onSubmit: (result: GateFrameOption) => void

    constructor(app: App, gateOptions: GateFrameOption, onSubmit: (result: GateFrameOption) => void) {
        super(app)
        this.onSubmit = onSubmit
        this.gateOptions = gateOptions
    }

    onOpen() {
        const { contentEl } = this
        contentEl.createEl('h3', { text: 'Extended Browser' })
        createFormEditGate(contentEl, this.gateOptions, (result) => {
            this.onSubmit(result)
            this.close()
        })
    }

    onClose() {
        this.contentEl.empty()
    }
}

export class ModalInsertLink extends Modal {
    onSubmit: (result: GateFrameOption) => void

    constructor(app: App, onSubmit: (result: GateFrameOption) => void) {
        super(app)
        this.onSubmit = onSubmit
    }

    onOpen() {
        this.titleEl.setText('Insert Link')
        this.createFormInsertLink()
    }

    onClose() {
        this.contentEl.empty()
    }

    createFormInsertLink() {
        let gateOptions = createEmptyGateOption()
        new Setting(this.contentEl)
            .setName('URL')
            .setClass('extended-browser-form-field')
            .addText((text) =>
                text.setPlaceholder('https://example.com').onChange((value) => {
                    gateOptions.url = value
                })
            )

        new Setting(this.contentEl)
            .setName('Title')
            .setClass('extended-browser-form-field')
            .addText((text) =>
                text.onChange((value) => {
                    gateOptions.title = value
                })
            )

        new Setting(this.contentEl).addButton((btn) =>
            btn
                .setButtonText('Insert Link')
                .setCta()
                .onClick(() => {
                    gateOptions = normalizeGateOption(gateOptions)
                    this.onSubmit(gateOptions)
                })
        )
    }
}

export class ModalListGates extends Modal {
    gates: Record<string, GateFrameOption>
    onSubmit: (result: GateFrameOption) => void
    getOpenViewContext?: (gate: GateFrameOption) => OpenViewContext | undefined

    constructor(
        app: App,
        gates: Record<string, GateFrameOption>,
        onSubmit: (result: GateFrameOption) => void,
        getOpenViewContext?: (gate: GateFrameOption) => OpenViewContext | undefined
    ) {
        super(app)
        this.onSubmit = onSubmit
        this.gates = gates
        this.getOpenViewContext = getOpenViewContext
    }

    onOpen() {
        const { contentEl } = this

        for (const gateId in this.gates) {
            const gate = this.gates[gateId]
            const container = contentEl.createEl('div', {
                cls: 'extended-browser-quick-list-item'
            })

            if (!gate.icon.startsWith('<svg')) {
                const iconSvg = getIcon(gate.icon) ?? getIcon('link-external')
                if (iconSvg) {
                    iconSvg.classList.add('svg-icon')
                    container.appendChild(iconSvg)
                }
            } else {
                appendSvgIcon(container, gate.icon)
            }

            container.createEl('span', { text: gate.title })

            container.addEventListener('click', () => {
                void openView(
                    this.app.workspace,
                    gate.id,
                    gate.position,
                    gate.openMode ?? 'tab',
                    this.getOpenViewContext?.(gate)
                ).catch((error) => {
                    console.error('Extended Browser: failed to open passkey from list', error)
                })
                this.close()
            })
        }
    }
}

export const setupInsertLinkMenu = (plugin: { app: App; registerEvent: (event: unknown) => void }) => {
    plugin.registerEvent(
        plugin.app.workspace.on('editor-menu', (menu: Menu, editor: Editor) => {
            menu.addItem((item) => {
                item.setTitle('Insert Gate Link').onClick(() => {
                    const modal = new ModalInsertLink(plugin.app, (gate: GateFrameOption) => {
                        const gateLink = `[${gate.title}](obsidian://extended-browser?title=${encodeURIComponent(gate.title)}&url=${encodeURIComponent(gate.url)})`
                        editor.replaceSelection(gateLink)
                        modal.close()
                    })
                    modal.open()
                })
            })
        })
    )
}
