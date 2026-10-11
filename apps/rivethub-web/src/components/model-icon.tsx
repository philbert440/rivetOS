/**
 * Brand logo for an agent's model or harness (lib/model-icon.ts picks the
 * key). The SVGs come from @lobehub/icons-static-svg (MIT), bundled at build
 * time so the desktop shell needs no network. Inlined, so single-colour
 * marks take currentColor and follow the theme; the -color variants keep
 * their brand colours.
 */

import type { JSX } from 'react'
import type { ModelIconKey } from '../lib/model-icon.js'
import claudeSvg from '@lobehub/icons-static-svg/icons/claude-color.svg?raw'
import claudecodeSvg from '@lobehub/icons-static-svg/icons/claudecode-color.svg?raw'
import grokSvg from '@lobehub/icons-static-svg/icons/grok.svg?raw'
import zhipuSvg from '@lobehub/icons-static-svg/icons/zhipu-color.svg?raw'
import nvidiaSvg from '@lobehub/icons-static-svg/icons/nvidia-color.svg?raw'
import deepseekSvg from '@lobehub/icons-static-svg/icons/deepseek-color.svg?raw'
import kimiSvg from '@lobehub/icons-static-svg/icons/kimi-color.svg?raw'
import qwenSvg from '@lobehub/icons-static-svg/icons/qwen-color.svg?raw'
import geminiSvg from '@lobehub/icons-static-svg/icons/gemini-color.svg?raw'
import geminicliSvg from '@lobehub/icons-static-svg/icons/geminicli-color.svg?raw'
import openaiSvg from '@lobehub/icons-static-svg/icons/openai.svg?raw'
import codexSvg from '@lobehub/icons-static-svg/icons/codex-color.svg?raw'
import mistralSvg from '@lobehub/icons-static-svg/icons/mistral-color.svg?raw'
import minimaxSvg from '@lobehub/icons-static-svg/icons/minimax-color.svg?raw'
import metaSvg from '@lobehub/icons-static-svg/icons/meta-color.svg?raw'
import nousresearchSvg from '@lobehub/icons-static-svg/icons/nousresearch.svg?raw'
import hermesagentSvg from '@lobehub/icons-static-svg/icons/hermesagent.svg?raw'
import opencodeSvg from '@lobehub/icons-static-svg/icons/opencode.svg?raw'
import cursorSvg from '@lobehub/icons-static-svg/icons/cursor.svg?raw'
import piSvg from '@lobehub/icons-static-svg/icons/pi.svg?raw'

const SVGS: Record<ModelIconKey, string> = {
  claude: claudeSvg,
  claudecode: claudecodeSvg,
  grok: grokSvg,
  zhipu: zhipuSvg,
  nvidia: nvidiaSvg,
  deepseek: deepseekSvg,
  kimi: kimiSvg,
  qwen: qwenSvg,
  gemini: geminiSvg,
  geminicli: geminicliSvg,
  openai: openaiSvg,
  codex: codexSvg,
  mistral: mistralSvg,
  minimax: minimaxSvg,
  meta: metaSvg,
  nousresearch: nousresearchSvg,
  hermesagent: hermesagentSvg,
  opencode: opencodeSvg,
  cursor: cursorSvg,
  pi: piSvg,
}

/** The pack's <title> would show a native tooltip and repeat the agent's
 *  name in the row's text; the name is already beside the logo. */
const TITLE = /<title>[^<]*<\/title>/

export function ModelIcon(props: { icon: ModelIconKey; className?: string }): JSX.Element {
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center leading-none [&>svg]:block ${props.className ?? ''}`}
      // Local, build-time SVG from a pinned package, never user input.
      dangerouslySetInnerHTML={{ __html: SVGS[props.icon].replace(TITLE, '') }}
    />
  )
}
