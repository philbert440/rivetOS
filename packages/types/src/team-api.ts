/**
 * rivet-team household users — wire contract.
 *
 * A TeamUser is a human (not a node, not a persona). Their personas and
 * notes live in a dedicated Postgres schema that a dedicated role can
 * read; they never share `ros_messages` with the Rivet agent corpus.
 *
 * Pairing is a one-time code, like mesh device enroll. Subsequent calls
 * send the device token. The mesh den bearer must not be required for
 * redeem or for a paired device to read its own notes.
 */

export interface TeamUser {
  id: string
  handle: string
  displayName: string
  /** Postgres schema that holds this user's personas + notes. */
  schemaName: string
  /** Postgres role that can use only `schemaName`. */
  roleName: string
  createdAt: number
}

export interface TeamPersona {
  id: string
  userId: string
  name: string
  systemPrompt: string
  threadId: string
  createdAt: number
  sample?: boolean
}

export interface TeamNote {
  id: string
  userId: string
  personaId: string
  role: string
  content: string
  createdAt: number
}

export interface TeamDevice {
  id: string
  userId: string
  label: string
  createdAt: number
}

export interface TeamCreateUserRequest {
  handle: string
  displayName: string
}

export interface TeamUserResponse {
  user: TeamUser
}

export interface TeamUsersListResponse {
  users: TeamUser[]
}

export interface TeamPairStartResponse {
  code: string
  expiresAt: number
}

export interface TeamPairRedeemRequest {
  code: string
  label?: string
}

export interface TeamPairRedeemResponse {
  user: TeamUser
  deviceId: string
  /** Present once. Store on the device; send as Bearer on /api/team/*. */
  deviceToken: string
}

export interface TeamMeResponse {
  user: TeamUser
  device: TeamDevice
}

export interface TeamPersonaCreateRequest {
  name: string
  systemPrompt: string
}

export interface TeamPersonasResponse {
  personas: TeamPersona[]
}

export interface TeamPersonaResponse {
  persona: TeamPersona
}

export interface TeamNoteCreateRequest {
  personaId: string
  role: string
  content: string
}

export interface TeamNotesSearchResponse {
  notes: TeamNote[]
}
