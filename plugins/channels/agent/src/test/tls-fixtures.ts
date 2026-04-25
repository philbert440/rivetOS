/**
 * TLS test fixtures — generate ephemeral CA + cert pairs for testing mTLS.
 * Uses shell-out to openssl (available on all dev/CI machines).
 */

import { execSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface TlsFixtures {
  /** CA certificate PEM (Buffer) */
  caCert: Buffer
  /** Server/client certificate PEM — signed by our CA */
  cert: Buffer
  /** Server/client private key PEM */
  key: Buffer
  /** Second CA (for testing rejection of foreign-CA certs) */
  foreignCaCert: Buffer
  /** Cert signed by foreign CA */
  foreignCert: Buffer
  /** Key for foreign cert */
  foreignKey: Buffer
  /** Cleanup function — removes temp dir */
  cleanup: () => void
}

export function generateTlsFixtures(): TlsFixtures {
  const dir = mkdtempSync(join(tmpdir(), 'rivetos-tls-test-'))

  try {
    // Generate our CA
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${dir}/ca.key" -out "${dir}/ca.crt" ` +
        `-days 1 -nodes -subj "/CN=test-ca"`,
      { stdio: 'pipe' },
    )

    // Generate our node key + CSR + cert signed by our CA
    execSync(`openssl genrsa -out "${dir}/node.key" 2048`, { stdio: 'pipe' })
    execSync(`openssl req -new -key "${dir}/node.key" -out "${dir}/node.csr" -subj "/CN=ct111"`, {
      stdio: 'pipe',
    })
    execSync(
      `openssl x509 -req -in "${dir}/node.csr" -CA "${dir}/ca.crt" -CAkey "${dir}/ca.key" ` +
        `-CAcreateserial -out "${dir}/node.crt" -days 1`,
      { stdio: 'pipe' },
    )

    // Generate a foreign CA + cert (for rejection tests)
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${dir}/foreign-ca.key" -out "${dir}/foreign-ca.crt" ` +
        `-days 1 -nodes -subj "/CN=foreign-ca"`,
      { stdio: 'pipe' },
    )
    execSync(`openssl genrsa -out "${dir}/foreign.key" 2048`, { stdio: 'pipe' })
    execSync(
      `openssl req -new -key "${dir}/foreign.key" -out "${dir}/foreign.csr" -subj "/CN=foreign-node"`,
      { stdio: 'pipe' },
    )
    execSync(
      `openssl x509 -req -in "${dir}/foreign.csr" -CA "${dir}/foreign-ca.crt" -CAkey "${dir}/foreign-ca.key" ` +
        `-CAcreateserial -out "${dir}/foreign.crt" -days 1`,
      { stdio: 'pipe' },
    )

    return {
      caCert: readFileSync(`${dir}/ca.crt`),
      cert: readFileSync(`${dir}/node.crt`),
      key: readFileSync(`${dir}/node.key`),
      foreignCaCert: readFileSync(`${dir}/foreign-ca.crt`),
      foreignCert: readFileSync(`${dir}/foreign.crt`),
      foreignKey: readFileSync(`${dir}/foreign.key`),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
}
