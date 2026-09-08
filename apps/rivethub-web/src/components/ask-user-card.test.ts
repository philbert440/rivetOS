import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { AskUserCard } from './ask-user-card.js'

it('renders a native text input for every question including later optionless questions', () => {
  const html = renderToStaticMarkup(
    createElement(AskUserCard, {
      questions: [
        { question: 'Color?', options: [{ label: 'Blue' }], multiSelect: false, freeText: true },
        { question: 'Name?', options: [], multiSelect: false, freeText: true },
      ],
      onAnswer: async () => {},
      onAnswerStructured: async () => {},
      onDismiss: () => {},
    }),
  )
  expect(html).toContain('Type your own answer to question 1')
  expect(html).toContain('Type your own answer to question 2')
  expect(html).not.toContain('answer in the terminal')
  expect(html).toContain('Send answers')
})
