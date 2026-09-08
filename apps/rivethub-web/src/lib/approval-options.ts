/** Match the driver's approvalKeyFromOptions labels. Missing affirmative rows
 * mean an incomplete capture (notably Kimi), whose driver still has a fallback.
 */
export function supportsSessionApproval(labels: string[]): boolean {
  const remember = /don'?t ask|always|never ask|for this session|this session/i
  const yes = /^(yes|proceed|approve|allow|accept)\b/i
  const no = /^(no|reject|deny|decline)\b/i
  return (
    !labels.some((label) => yes.test(label)) ||
    labels.some((label) => remember.test(label) && !no.test(label))
  )
}
