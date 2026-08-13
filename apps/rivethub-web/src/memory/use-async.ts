import { useCallback, useEffect, useRef, useState } from 'react'

export interface AsyncState<T> {
  data: T | undefined
  error: Error | undefined
  loading: boolean
  reload: () => void
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<Error | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  const seq = useRef(0)

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    const mine = ++seq.current
    setLoading(true)
    setError(undefined)
    fn()
      .then((d) => {
        if (seq.current === mine) {
          setData(d)
          setLoading(false)
        }
      })
      .catch((e: unknown) => {
        if (seq.current === mine) {
          setError(e instanceof Error ? e : new Error(String(e)))
          setLoading(false)
        }
      })
  }, [...deps, nonce])

  return { data, error, loading, reload }
}
