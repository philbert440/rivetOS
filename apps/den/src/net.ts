// Where the den-server lives. When the viewer is served BY den-server the
// API is same-origin; in vite dev it's the default den port on the same host.
// `?server=host:port` overrides both (and `?token=` rides along for auth).

const params = new URLSearchParams(location.search)
const override = params.get('server')
const token = params.get('token') ?? ''

const DEV_PORT = 5174
const sameOrigin = !import.meta.env.DEV && !override

export const serverHttp = override
  ? `${location.protocol}//${override}`
  : sameOrigin
    ? ''
    : `${location.protocol}//${location.hostname}:${DEV_PORT}`

export const serverWs =
  (override
    ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${override}`
    : sameOrigin
      ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`
      : `ws://${location.hostname}:${DEV_PORT}`) + '/ws'

export const withToken = (url: string): string =>
  token ? `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : url
