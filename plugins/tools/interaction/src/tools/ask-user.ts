/**
 * ask_user — Structured question tool for agents.
 *
 * When an agent needs clarification, preferences, or confirmation from the user,
 * it calls this tool instead of guessing. The tool formats the question and
 * returns it as the tool result, which the model then delivers to the user.
 *
 * The user's reply arrives as a new message in the next turn.
 */

import type { Tool, ToolContext } from '@rivetos/types'

type QuestionType = 'free_text' | 'yes_no' | 'multiple_choice'

interface AskUserArgs {
  question: string
  type?: QuestionType
  choices?: string[]
  default_value?: string
  context?: string
}

export function createAskUserTool(): Tool {
  return {
    name: 'ask_user',
    description:
      'Ask the user a question when you need clarification, confirmation, or a choice. ' +
      'Use instead of guessing. Supports free text, yes/no, and multiple choice questions.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The question to ask the user.',
        },
        type: {
          type: 'string',
          enum: ['free_text', 'yes_no', 'multiple_choice'],
          description: 'Question type. Defaults to free_text.',
        },
        choices: {
          type: 'array',
          items: { type: 'string' },
          description: 'Options for multiple_choice questions.',
        },
        default_value: {
          type: 'string',
          description: 'Default answer if user just hits enter / says nothing specific.',
        },
        context: {
          type: 'string',
          description: 'Optional context explaining why you need this information.',
        },
      },
      required: ['question'],
    },

    async execute(
      rawArgs: Record<string, unknown>,
      _signal?: AbortSignal,
      _ctx?: ToolContext,
    ): Promise<string> {
      const args = rawArgs as unknown as AskUserArgs

      if (!args.question || typeof args.question !== 'string' || !args.question.trim()) {
        return 'Error: question is required and must be a non-empty string.'
      }

      const type: QuestionType = args.type ?? 'free_text'
      const validTypes: QuestionType[] = ['free_text', 'yes_no', 'multiple_choice']

      if (!validTypes.includes(type)) {
        return `Error: invalid type "${type}". Must be one of: ${validTypes.join(', ')}`
      }

      if (type === 'multiple_choice') {
        if (!args.choices || !Array.isArray(args.choices) || args.choices.length < 2) {
          return 'Error: multiple_choice requires a "choices" array with at least 2 options.'
        }
      }

      // Build the formatted question
      const parts: string[] = []

      if (args.context) {
        parts.push(`Context: ${args.context}`)
        parts.push('')
      }

      parts.push(`Question: ${args.question.trim()}`)

      if (type === 'yes_no') {
        const defaultHint = args.default_value ? ` (default: ${args.default_value})` : ''
        parts.push(`Options: Yes / No${defaultHint}`)
      } else if (type === 'multiple_choice' && args.choices) {
        parts.push('Options:')
        args.choices.forEach((choice, i) => {
          parts.push(`  ${i + 1}. ${choice}`)
        })
        if (args.default_value) {
          parts.push(`Default: ${args.default_value}`)
        }
      } else if (args.default_value) {
        parts.push(`Default: ${args.default_value}`)
      }

      return parts.join('\n')
    },
  }
}
