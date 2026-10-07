/**
 * Mount surface for canvas tests. jsdom is not installed in this tree and
 * must not be added here; this shim is enough for createRoot plus the
 * pointer and key listeners the canvas registers.
 */

const ELEMENT_NODE = 1
const TEXT_NODE = 3
const DOCUMENT_NODE = 9

const NODE_FILTER = {
  SHOW_ELEMENT: 1,
  SHOW_TEXT: 4,
  FILTER_ACCEPT: 1,
  FILTER_REJECT: 2,
  FILTER_SKIP: 3,
} as const

interface ListenerRec {
  fn: (event: DomEvent) => void
  capture: boolean
}

class DomEvent {
  type: string
  bubbles: boolean
  cancelable: boolean
  defaultPrevented = false
  cancelBubble = false
  stopImmediate = false
  timeStamp = 0
  eventPhase = 0
  target: EventTarget | null = null
  currentTarget: EventTarget | null = null
  clientX = 0
  clientY = 0
  deltaX = 0
  deltaY = 0
  pointerId = 1
  pointerType = 'mouse'
  button = 0
  buttons = 0
  detail = 0
  which = 0
  key = ''
  code = ''
  ctrlKey = false
  metaKey = false
  altKey = false
  shiftKey = false
  repeat = false
  view: unknown = null

  constructor(type: string, init: EventInit & Record<string, unknown> = {}) {
    this.type = type
    this.bubbles = init.bubbles !== false
    this.cancelable = init.cancelable !== false
    this.timeStamp = Date.now()
    assignInit(this, init)
  }

  preventDefault(): void {
    if (this.cancelable) this.defaultPrevented = true
  }

  stopPropagation(): void {
    this.cancelBubble = true
  }

  stopImmediatePropagation(): void {
    this.cancelBubble = true
    this.stopImmediate = true
  }
}

function assignInit(event: DomEvent, init: Record<string, unknown>): void {
  for (const key of [
    'clientX',
    'clientY',
    'deltaX',
    'deltaY',
    'pointerId',
    'pointerType',
    'button',
    'buttons',
    'detail',
    'which',
    'key',
    'code',
    'ctrlKey',
    'metaKey',
    'altKey',
    'shiftKey',
    'repeat',
  ] as const) {
    if (init[key] !== undefined) {
      const value = init[key]
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        Object.assign(event, { [key]: value })
      }
    }
  }
}

class DomMouseEvent extends DomEvent {}
class DomPointerEvent extends DomMouseEvent {}
class DomKeyboardEvent extends DomEvent {}

function createStyle(): CSSStyleDeclaration {
  const values = new Map<string, string>()
  const api = {
    setProperty: (name: string, value: string): void => {
      values.set(name, value)
    },
    getPropertyValue: (name: string): string => values.get(name) ?? '',
    removeProperty: (name: string): string => {
      const prev = values.get(name) ?? ''
      values.delete(name)
      return prev
    },
    get cssText(): string {
      return [...values.entries()].map(([name, value]) => `${name}: ${value}`).join('; ')
    },
    set cssText(_value: string) {
      values.clear()
    },
  }
  return new Proxy(api, {
    get(target, prop): unknown {
      if (prop === 'setProperty') return target.setProperty
      if (prop === 'getPropertyValue') return target.getPropertyValue
      if (prop === 'removeProperty') return target.removeProperty
      if (prop === 'cssText') return target.cssText
      if (typeof prop !== 'string') return undefined
      return values.get(prop) ?? ''
    },
    set(_target, prop, value) {
      if (typeof prop === 'string') values.set(prop, String(value))
      return true
    },
  }) as unknown as CSSStyleDeclaration
}

class DomNode {
  parentNode: DomNode | null = null
  previousSibling: DomNode | null = null
  nextSibling: DomNode | null = null
  childNodes: DomNode[] = []
  ownerDocument: DomDocument | null = null
  nodeValue = ''
  listeners = new Map<string, ListenerRec[]>()

  constructor(
    readonly nodeType: number,
    readonly nodeName: string,
  ) {}

  get firstChild(): DomNode | null {
    return this.childNodes[0] ?? null
  }

  get lastChild(): DomNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null
  }

  get textContent(): string {
    if (this.nodeType === TEXT_NODE) return this.nodeValue
    return this.childNodes.map((child) => child.textContent).join('')
  }

  set textContent(value: string) {
    this.childNodes = []
    if (value && this.ownerDocument) this.appendChild(this.ownerDocument.createTextNode(value))
    else if (value) this.nodeValue = value
  }

  appendChild<T extends DomNode>(child: T): T {
    if (child.parentNode) child.parentNode.removeChild(child)
    this.childNodes.push(child)
    this.relink()
    return child
  }

  insertBefore<T extends DomNode>(child: T, before: DomNode | null): T {
    if (before === null) return this.appendChild(child)
    if (child.parentNode) child.parentNode.removeChild(child)
    const index = this.childNodes.indexOf(before)
    if (index < 0) this.childNodes.push(child)
    else this.childNodes.splice(index, 0, child)
    this.relink()
    return child
  }

  removeChild<T extends DomNode>(child: T): T {
    const index = this.childNodes.indexOf(child)
    if (index >= 0) this.childNodes.splice(index, 1)
    child.parentNode = null
    child.previousSibling = null
    child.nextSibling = null
    this.relink()
    return child
  }

  contains(other: DomNode | null): boolean {
    let node: DomNode | null = other
    while (node) {
      if (node === this) return true
      node = node.parentNode
    }
    return false
  }

  compareDocumentPosition(other: DomNode): number {
    if (this === other) return 0
    if (this.contains(other)) return 16
    if (other.contains(this)) return 8
    return 4
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (typeof listener !== 'function') return
    const capture = typeof options === 'boolean' ? options : options?.capture === true
    const list = this.listeners.get(type) ?? []
    list.push({ fn: listener as unknown as (event: DomEvent) => void, capture })
    this.listeners.set(type, list)
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (typeof listener !== 'function') return
    const capture = typeof options === 'boolean' ? options : options?.capture === true
    const list = this.listeners.get(type)
    if (!list) return
    const fn = listener as unknown as (event: DomEvent) => void
    this.listeners.set(
      type,
      list.filter((rec) => rec.fn !== fn || rec.capture !== capture),
    )
  }

  dispatchEvent(event: DomEvent): boolean {
    return dispatch(this, event)
  }

  private relink(): void {
    let prev: DomNode | null = null
    for (const child of this.childNodes) {
      child.parentNode = this
      child.previousSibling = prev
      if (prev) prev.nextSibling = child
      prev = child
    }
    if (prev) prev.nextSibling = null
  }

  fire(event: DomEvent, capture: boolean): void {
    const list = this.listeners.get(event.type)
    if (!list) return
    for (const rec of [...list]) {
      if (rec.capture !== capture) continue
      writeEventField(event, 'currentTarget', this)
      rec.fn(event)
      if (event.stopImmediate) break
    }
  }
}

class DomClassList {
  constructor(private readonly el: DomElement) {}

  private tokens(): string[] {
    return (this.el.getAttribute('class') ?? '').split(/\s+/).filter((token) => token !== '')
  }

  private write(tokens: string[]): void {
    if (tokens.length === 0) this.el.removeAttribute('class')
    else this.el.setAttribute('class', tokens.join(' '))
  }

  add(...names: string[]): void {
    const tokens = this.tokens()
    for (const name of names) if (!tokens.includes(name)) tokens.push(name)
    this.write(tokens)
  }

  remove(...names: string[]): void {
    const drop = new Set(names)
    this.write(this.tokens().filter((token) => !drop.has(token)))
  }

  contains(name: string): boolean {
    return this.tokens().includes(name)
  }

  toggle(name: string): boolean {
    if (this.contains(name)) {
      this.remove(name)
      return false
    }
    this.add(name)
    return true
  }
}

class DomElement extends DomNode {
  readonly style = createStyle()
  readonly classList = new DomClassList(this)
  clientWidth = 1280
  clientHeight = 800
  namespaceURI = 'http://www.w3.org/1999/xhtml'
  private readonly attrs = new Map<string, string>()
  private readonly captured = new Set<number>()

  constructor(tag: string) {
    super(ELEMENT_NODE, tag.toUpperCase())
  }

  get tagName(): string {
    return this.nodeName
  }

  get id(): string {
    return this.getAttribute('id') ?? ''
  }

  set id(value: string) {
    this.setAttribute('id', value)
  }

  get className(): string {
    return this.getAttribute('class') ?? ''
  }

  set className(value: string) {
    this.setAttribute('class', value)
  }

  get innerHTML(): string {
    return this.textContent
  }

  set innerHTML(value: string) {
    this.textContent = value
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
  }

  setAttributeNS(_ns: string | null, name: string, value: string): void {
    this.setAttribute(name, value)
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name)
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name)
  }

  focus(): void {
    if (this.ownerDocument) this.ownerDocument.activeElement = this
  }

  blur(): void {
    if (this.ownerDocument) this.ownerDocument.activeElement = this.ownerDocument.body
  }

  click(): void {
    this.dispatchEvent(new DomMouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }))
  }

  getBoundingClientRect(): DOMRect {
    const width = this.clientWidth
    const height = this.clientHeight
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON() {
        return {}
      },
    }
  }

  setPointerCapture(pointerId: number): void {
    this.captured.add(pointerId)
  }

  releasePointerCapture(pointerId: number): void {
    this.captured.delete(pointerId)
  }

  hasPointerCapture(pointerId: number): boolean {
    return this.captured.has(pointerId)
  }

  get children(): DomElement[] {
    return this.childNodes.filter((child): child is DomElement => child instanceof DomElement)
  }

  get parentElement(): DomElement | null {
    return this.parentNode instanceof DomElement ? this.parentNode : null
  }

  get firstElementChild(): DomElement | null {
    for (const child of this.childNodes) {
      if (child instanceof DomElement) return child
    }
    return null
  }

  get lastElementChild(): DomElement | null {
    for (let i = this.childNodes.length - 1; i >= 0; i--) {
      const child = this.childNodes[i]
      if (child instanceof DomElement) return child
    }
    return null
  }

  insertAdjacentElement(position: string, element: DomElement): DomElement {
    if (position === 'afterbegin') this.insertBefore(element, this.firstElementChild)
    else this.appendChild(element)
    return element
  }

  closest(selector: string): DomElement | null {
    return closestFrom(this, selector)
  }

  querySelector(selector: string): DomElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector: string): DomElement[] {
    const out: DomElement[] = []
    walkElements(this, (el) => {
      if (matches(el, selector)) out.push(el)
    })
    return out
  }

  remove(): void {
    this.parentNode?.removeChild(this)
  }
}

class DomHTMLElement extends DomElement {
  /** HTML inputs default to text. React ignores onChange when `type` is missing. */
  get type(): string {
    const attr = this.getAttribute('type')
    if (attr !== null) return attr
    return this.nodeName === 'INPUT' ? 'text' : ''
  }

  set type(value: string) {
    this.setAttribute('type', value)
  }

  /** Buttons and inputs are in the tab order unless tabindex says otherwise. */
  get tabIndex(): number {
    const attr = this.getAttribute('tabindex')
    if (attr !== null) {
      const parsed = Number(attr)
      return Number.isFinite(parsed) ? parsed : -1
    }
    switch (this.nodeName) {
      case 'INPUT':
      case 'BUTTON':
      case 'SELECT':
      case 'TEXTAREA':
        return 0
      default:
        return -1
    }
  }

  set tabIndex(value: number) {
    this.setAttribute('tabindex', String(value))
  }
}

/** Inputs are a distinct class so Radix can `instanceof HTMLInputElement`. */
class DomInputElement extends DomHTMLElement {
  select(): void {}
}

class DomText extends DomNode {
  constructor(text: string) {
    super(TEXT_NODE, '#text')
    this.nodeValue = text
  }
}

class DomDocument extends DomNode {
  documentElement: DomElement | null = null
  head: DomElement | null = null
  body: DomElement | null = null
  activeElement: DomElement | null = null
  defaultView: DomWindow | null = null
  compatMode = 'CSS1Compat'
  /**
   * React decides once, at import, whether `input` events drive onChange
   * (`"oninput" in document`). Without this it uses a legacy path that
   * ignores `input`, so controlled fields never update in these tests.
   */
  oninput: unknown = null

  constructor() {
    super(DOCUMENT_NODE, '#document')
    this.ownerDocument = this
  }

  createElement(tag: string): DomHTMLElement {
    const el = tag.toLowerCase() === 'input' ? new DomInputElement(tag) : new DomHTMLElement(tag)
    el.ownerDocument = this
    return el
  }

  /** Radix focus scope walks tabbable descendants. SHOW_ELEMENT only. */
  createTreeWalker(
    root: DomNode,
    _whatToShow?: number,
    filter?: { acceptNode?: (node: DomNode) => number } | null,
  ): { currentNode: DomNode; nextNode: () => DomNode | null } {
    const accepted: DomNode[] = []
    const visit = (node: DomNode): void => {
      for (const child of node.childNodes) {
        if (!(child instanceof DomElement)) continue
        const verdict = filter?.acceptNode?.(child) ?? NODE_FILTER.FILTER_ACCEPT
        if (verdict === NODE_FILTER.FILTER_REJECT) continue
        if (verdict === NODE_FILTER.FILTER_ACCEPT) accepted.push(child)
        visit(child)
      }
    }
    visit(root)
    let index = 0
    return {
      currentNode: root,
      nextNode(): DomNode | null {
        const next = accepted[index]
        index += 1
        if (!next) return null
        this.currentNode = next
        return next
      },
    }
  }

  createElementNS(_ns: string, tag: string): DomHTMLElement {
    return this.createElement(tag)
  }

  createTextNode(text: string): DomText {
    const node = new DomText(text)
    node.ownerDocument = this
    return node
  }

  createComment(text: string): DomText {
    return this.createTextNode(text)
  }

  getElementById(id: string): DomElement | null {
    return this.querySelector(`[id="${id}"]`)
  }

  querySelector(selector: string): DomElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector: string): DomElement[] {
    const out: DomElement[] = []
    walkElements(this, (el) => {
      if (matches(el, selector)) out.push(el)
    })
    return out
  }
}

class DomWindow {
  document: DomDocument
  HTMLIFrameElement = class DomIFrame {
    readonly frame = true
  }
  navigator = { userAgent: 'rivet-test' }
  location = {
    origin: 'http://192.168.1.20:8787',
    protocol: 'http:',
    href: 'http://192.168.1.20:8787/',
  }
  listeners = new Map<string, ListenerRec[]>()
  top: DomWindow
  self: DomWindow
  localStorage: Storage
  sessionStorage: Storage
  innerWidth = 1280
  innerHeight = 800
  // floating-ui checks `instanceof getWindow(node).HTMLElement`. The globals
  // below are not on this object, and a missing constructor throws.
  Node = DomNode
  Element = DomElement
  HTMLElement = DomHTMLElement
  HTMLInputElement = DomInputElement

  getComputedStyle(): {
    paddingLeft: string
    paddingTop: string
    paddingRight: string
    marginLeft: string
    marginTop: string
    marginRight: string
    getPropertyValue: (name: string) => string
  } {
    return {
      paddingLeft: '0',
      paddingTop: '0',
      paddingRight: '0',
      marginLeft: '0',
      marginTop: '0',
      marginRight: '0',
      getPropertyValue: () => '0',
    }
  }

  setTimeout(handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]): number {
    return globalThis.setTimeout(handler, timeout, ...args) as unknown as number
  }

  clearTimeout(id: number): void {
    globalThis.clearTimeout(id)
  }

  constructor(document: DomDocument) {
    this.document = document
    this.top = this
    this.self = this
    this.localStorage = storage()
    this.sessionStorage = storage()
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (typeof listener !== 'function') return
    const capture = typeof options === 'boolean' ? options : options?.capture === true
    const list = this.listeners.get(type) ?? []
    list.push({ fn: listener as unknown as (event: DomEvent) => void, capture })
    this.listeners.set(type, list)
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (typeof listener !== 'function') return
    const capture = typeof options === 'boolean' ? options : options?.capture === true
    const list = this.listeners.get(type)
    if (!list) return
    const fn = listener as unknown as (event: DomEvent) => void
    this.listeners.set(
      type,
      list.filter((rec) => rec.fn !== fn || rec.capture !== capture),
    )
  }

  dispatchEvent(event: DomEvent): boolean {
    return dispatch(this, event)
  }

  getSelection(): null {
    return null
  }

  fire(event: DomEvent, capture: boolean): void {
    const list = this.listeners.get(event.type)
    if (!list) return
    for (const rec of [...list]) {
      if (rec.capture !== capture) continue
      writeEventField(event, 'currentTarget', this)
      rec.fn(event)
      if (event.stopImmediate) break
    }
  }
}

type Dispatchable = DomNode | DomWindow

/** Native Event.target is read-only. Radix dispatches CustomEvent through this shim. */
function writeEventField(event: object, field: string, value: unknown): void {
  try {
    Object.defineProperty(event, field, { value, configurable: true, writable: true })
  } catch {
    /* already a non-configurable getter */
  }
}

function dispatch(target: Dispatchable, event: DomEvent): boolean {
  writeEventField(event, 'target', target)
  const chain = chainOf(target)
  let stopped = false
  for (const node of [...chain].reverse()) {
    writeEventField(event, 'currentTarget', node)
    node.fire(event, true)
    if (event.cancelBubble) {
      stopped = true
      break
    }
  }
  if (!stopped && event.bubbles) {
    for (const node of chain) {
      writeEventField(event, 'currentTarget', node)
      node.fire(event, false)
      if (event.cancelBubble) break
    }
  }
  // stopPropagation does not cancel the default action. preventDefault does.
  if (!event.defaultPrevented) applyDefault(event)
  return !event.defaultPrevented
}

/**
 * The slice of browser default actions these tests assert. A prevented key
 * must not activate the focused button; an unprevented Enter must. Pointer
 * down focuses a tabbable button the way a browser does, so a later arrow
 * sees that focus. Capture retargeting is not modeled.
 */
function applyDefault(event: DomEvent): void {
  if (event.type === 'pointerdown') {
    const hit = event.target
    if (hit instanceof DomElement && hit.tagName === 'BUTTON') {
      if (hit.getAttribute('tabindex') === '-1') return
      hit.focus()
    }
    return
  }
  if (event.type === 'keydown' && event.key === 'Enter') {
    const active = (globalThis as unknown as { document?: DomDocument }).document?.activeElement
    if (active instanceof DomElement && active.tagName === 'BUTTON') active.click()
  }
}

function chainOf(target: Dispatchable): Dispatchable[] {
  if (target instanceof DomWindow) return [target]
  const chain: Dispatchable[] = []
  let node: DomNode | null = target
  while (node) {
    chain.push(node)
    node = node.parentNode
  }
  const doc = target.ownerDocument
  const last = chain[chain.length - 1]
  if (doc?.defaultView && last === doc) chain.push(doc.defaultView)
  return chain
}

function closestFrom(node: DomNode | null, selector: string): DomElement | null {
  let current = node
  while (current) {
    if (current instanceof DomElement && matches(current, selector)) return current
    current = current.parentNode
  }
  return null
}

function walkElements(node: DomNode, visit: (el: DomElement) => void): void {
  for (const child of node.childNodes) {
    if (child instanceof DomElement) {
      visit(child)
      walkElements(child, visit)
    }
  }
}

function matches(el: DomElement, selector: string): boolean {
  return selector.split(',').some((part) => matchesSimple(el, part.trim()))
}

function matchesSimple(el: DomElement, selector: string): boolean {
  if (selector === '') return false
  const attrs = [
    ...selector.matchAll(/\[([^\]=\s]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/g),
  ]
  const rest = selector.replace(/\[[^\]]*\]/g, '').trim()
  if (rest.startsWith('.')) {
    if (!el.classList.contains(rest.slice(1))) return false
  } else if (rest !== '' && rest !== '*') {
    if (el.tagName !== rest.toUpperCase()) return false
  }
  for (const match of attrs) {
    const name = match[1]
    if (!name) return false
    const expected = match.at(2) ?? match.at(3) ?? match.at(4)
    const actual = el.getAttribute(name)
    if (expected === undefined) {
      if (actual === null) return false
    } else if (actual !== expected) return false
  }
  return rest !== '' || attrs.length > 0
}

function storage(): Storage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
    clear: () => {
      values.clear()
    },
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    },
  }
}

function install(): void {
  const doc = new DomDocument()
  const win = new DomWindow(doc)
  doc.defaultView = win
  const html = doc.createElement('html')
  const head = doc.createElement('head')
  const body = doc.createElement('body')
  doc.appendChild(html)
  html.appendChild(head)
  html.appendChild(body)
  doc.documentElement = html
  doc.head = head
  doc.body = body
  doc.activeElement = body

  const globals = globalThis as unknown as Record<string, unknown>
  globals.window = win
  globals.document = doc
  globals.Element = DomElement
  globals.HTMLElement = DomHTMLElement
  globals.HTMLInputElement = DomInputElement
  globals.Node = DomNode
  globals.NodeFilter = NODE_FILTER
  globals.Event = DomEvent
  globals.MouseEvent = DomMouseEvent
  globals.PointerEvent = DomPointerEvent
  globals.KeyboardEvent = DomKeyboardEvent
  globals.localStorage = win.localStorage
  globals.sessionStorage = win.sessionStorage
  globals.getComputedStyle = (): { animationName: string } => ({ animationName: 'none' })
  globals.MutationObserver = class {
    observe(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return []
    }
  }
  globals.IS_REACT_ACT_ENVIRONMENT = true
  if (typeof globals.requestAnimationFrame !== 'function') {
    globals.requestAnimationFrame = (cb: FrameRequestCallback): number =>
      setTimeout(() => {
        cb(performance.now())
      }, 16) as unknown as number
    globals.cancelAnimationFrame = (id: number): void => {
      clearTimeout(id)
    }
  }
}

install()
