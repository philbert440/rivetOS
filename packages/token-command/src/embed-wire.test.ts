import { describe, it, expect } from 'vitest'
import {
  buildEmbedRequest,
  parseEmbedResponse,
  normalizeEmbedVector,
  parseEmbedWireShape,
  EMBEDDING_COLUMN_DIMS,
} from './embed-wire.js'

describe('buildEmbedRequest', () => {
  it('builds OpenAI shape by default path', () => {
    expect(
      buildEmbedRequest({
        endpoint: 'http://127.0.0.1:9401/',
        wireShape: 'openai',
        model: 'emb-1',
        input: ['hello'],
      }),
    ).toEqual({
      url: 'http://127.0.0.1:9401/v1/embeddings',
      body: { model: 'emb-1', input: ['hello'] },
    })
  })

  it('builds native passthrough without /v1/embeddings', () => {
    expect(
      buildEmbedRequest({
        endpoint: 'http://127.0.0.1:9401/embed',
        wireShape: 'native',
        model: 'emb-1',
        input: ['a', 'b'],
      }),
    ).toEqual({
      url: 'http://127.0.0.1:9401/embed',
      body: { model: 'emb-1', texts: ['a', 'b'], input: ['a', 'b'] },
    })
  })
})

describe('parseEmbedResponse', () => {
  it('parses OpenAI data[] with index', () => {
    const { vectors } = parseEmbedResponse(
      {
        data: [
          { index: 1, embedding: [0.1, 0.2] },
          { index: 0, embedding: [0.3, 0.4] },
        ],
      },
      2,
    )
    expect(vectors).toEqual([
      [0.3, 0.4],
      [0.1, 0.2],
    ])
  })

  it('parses native embeddings[]', () => {
    const { vectors } = parseEmbedResponse(
      {
        embeddings: [
          [1, 2],
          [3, 4],
        ],
      },
      2,
    )
    expect(vectors).toEqual([
      [1, 2],
      [3, 4],
    ])
  })
})

describe('normalizeEmbedVector', () => {
  it('slices when longer than expectedDims', () => {
    expect(normalizeEmbedVector([1, 2, 3, 4], { expectedDims: 2 })).toEqual([1, 2])
  })

  it('rejects when shorter than expectedDims', () => {
    expect(normalizeEmbedVector([1], { expectedDims: 2 })).toBeNull()
  })

  it('truncateDims slices without expectedDims', () => {
    expect(normalizeEmbedVector([1, 2, 3], { truncateDims: 2 })).toEqual([1, 2])
  })

  it('pins EMBEDDING_COLUMN_DIMS to the halfvec(1024) schema width', () => {
    expect(EMBEDDING_COLUMN_DIMS).toBe(1024)
    const wide = Array.from({ length: 1500 }, (_, i) => i)
    expect(normalizeEmbedVector(wide, { expectedDims: EMBEDDING_COLUMN_DIMS })).toHaveLength(1024)
  })
})

describe('parseEmbedWireShape', () => {
  it('defaults to openai', () => {
    expect(parseEmbedWireShape(undefined)).toBe('openai')
  })

  it('accepts native', () => {
    expect(parseEmbedWireShape('native')).toBe('native')
  })

  it('rejects unknown', () => {
    expect(parseEmbedWireShape('grpc')).toEqual({
      error: 'embed_wire_shape must be "openai" or "native"',
    })
  })
})
