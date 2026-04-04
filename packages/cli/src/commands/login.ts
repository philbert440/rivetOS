/**
 * rivetos login <provider>
 *
 * Authenticate with a provider that requires OAuth or special auth flow.
 * Currently supports: anthropic
 */

export default async function login(): Promise<void> {
  const provider = process.argv[3]

  if (!provider) {
    console.log('Usage: rivetos login <provider>')
    console.log('')
    console.log('Providers:')
    console.log('  anthropic    Claude Pro/Max OAuth login')
    return
  }

  switch (provider) {
    case 'anthropic': {
      // Dynamic import so we don't load OAuth deps unless needed
      const { generateAuthUrl, exchangeCode, saveTokens } =
        await import('@rivetos/provider-anthropic')
      const { createInterface } = await import('node:readline')

      console.log('🔐 Anthropic OAuth Login\n')

      const { url, verifier } = generateAuthUrl()

      console.log('Open this URL in your browser:\n')
      console.log(url)
      console.log("\nAfter approving, you'll be redirected to a page with a code.")
      console.log('Copy the authorization code and paste it below.\n')

      const rl = createInterface({ input: process.stdin, output: process.stdout })
      const code = await new Promise<string>((resolve) => {
        rl.question('Paste code (or full redirect URL): ', (answer) => {
          rl.close()
          resolve(answer.trim())
        })
      })

      if (!code) {
        console.error('No code provided.')
        process.exit(1)
      }

      // Extract code from URL if pasted
      let authCode = code
      try {
        const parsed = new URL(code)
        const urlCode = parsed.searchParams.get('code')
        if (urlCode) authCode = urlCode
      } catch {
        /* URL parse failed, use raw code */
      }

      console.log('\nExchanging code for tokens...')
      const tokens = await exchangeCode(authCode, verifier)
      await saveTokens(tokens)

      console.log('✅ Tokens saved to ~/.rivetos/anthropic-tokens.json')
      console.log(`Expires: ${new Date(tokens.expiresAt).toLocaleString()}`)
      break
    }

    default:
      console.error(`Unknown provider: ${provider}`)
      console.log('Available: anthropic')
      process.exit(1)
  }
}
