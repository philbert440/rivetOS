/**
 * Adapter store: OpenMausBot UI dispatch/API surface, rivet-team gateway
 * as the chat transport. Does not talk to the OpenMausBot harness server.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
} from "react";
import { getGateway } from "../../lib/gateway.js";
import { useTeam } from "../../stores/team.js";
import type { MausColor, MausMotion } from "@/lib/mascot";

export type { MausColor } from "@/lib/mascot";

export type EffortLevel = "low" | "medium" | "high" | string;

export interface OptionCardData {
  title: string;
  subtitle: string;
  options: string[];
  answered?: string;
  dismissed?: boolean;
  requestId?: string;
  tool?: string;
  held?: string;
  allowKey?: string;
}

export interface Message {
  id: string;
  role: "bot" | "user";
  kind: "text" | "options" | "activity" | "screen";
  text?: string;
  card?: OptionCardData;
  tool?: { name: string; ok?: boolean; spoken?: string; setup?: boolean };
  png?: string;
  mime?: string;
  at: number;
  parentId?: string | null;
  from?: { botId: string; name: string; color: MausColor };
  reactions?: Array<{ emoji: string; by: string }>;
  comm?: { groupId: string; withBotId: string; withName: string; withColor: MausColor };
}

export type GroupDefaultResponder =
  | { kind: "member"; botId: string }
  | { kind: "everyone" }
  | { kind: "mentions" };

export interface Group {
  id: string;
  threadId: string;
  name: string;
  memberIds: string[];
  defaultResponder: GroupDefaultResponder;
  bulletin: string;
  unread: boolean;
  createdAt: number;
  dm?: boolean;
  busyBotId?: string | null;
  messages: Message[];
}

export interface ModelSelection {
  instanceId: string;
  model: string;
  effort?: EffortLevel;
}

export interface Task {
  threadId: string;
  title: string;
  createdAt: number;
}

export interface Bot {
  id: string;
  threadId: string;
  tasks?: Task[];
  name: string;
  title: string;
  description: string;
  notifications: boolean;
  color: MausColor;
  mascotExpression?: string | null;
  unread: boolean;
  busy?: boolean;
  modelSelection: ModelSelection;
  computer?: "cloud" | "vm" | "local" | "off";
  autoApprove?: boolean;
  alwaysAllow?: string[];
  speakReplies?: boolean;
  voice?: string;
  pinned?: boolean;
  hidden?: boolean;
  chiefOfStaff?: boolean;
  approvePeerComms?: boolean;
  messages: Message[];
  activeLeafId?: string | null;
}

export function visibleMessages(bot: Bot): Message[] {
  const leafId = bot.activeLeafId;
  if (!leafId) return bot.messages;
  const byId = new Map(bot.messages.map((m) => [m.id, m]));
  if (!byId.has(leafId)) return bot.messages;
  const path: Message[] = [];
  let cur = byId.get(leafId);
  while (cur) {
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path.reverse();
}

export function messageVersions(bot: Bot, message: Message): Message[] {
  if (message.role !== "user" || message.kind !== "text") return [message];
  return bot.messages
    .filter(
      (m) => m.role === "user" && m.kind === "text" && (m.parentId ?? null) === (message.parentId ?? null),
    )
    .sort((a, b) => a.at - b.at);
}

export interface ConfigStatus {
  xai?: { configured: boolean };
  composio: { configured: boolean; apiKeyConfigured?: boolean };
  box: { configured: boolean };
  opencodeGo?: { configured: boolean };
  tts?: { configured: boolean; ready: boolean; voice: string };
  profile?: { name: string; email: string };
}

export interface EngineInstall {
  command?: Partial<Record<"darwin" | "win32" | "linux", string>>;
  docsUrl?: string;
  signInCommand?: string;
  needsNode?: boolean;
}

export interface InstanceInfo {
  instanceId: string;
  driverKind: string;
  displayName: string;
  snapshot: {
    state: "available" | "unavailable";
    reason?: string;
    authenticated?: boolean;
    version?: string | null;
  };
  models: { default: string; options: Array<{ id: string; label: string }> };
  capabilities?: { computerMcp?: boolean; agentsMcp?: boolean; effortLevels?: readonly EffortLevel[] };
  install?: EngineInstall;
}

export type AppSettingsSection = "general" | "connections" | "voice" | "computer";

export interface Routine {
  id: string;
}
export type RoutineInput = Record<string, unknown>;
export interface RoutineRun {
  id: string;
  scheduledFor: number;
  status: string;
  seenAt?: number | null;
}
export interface WebhookTrigger {
  id: string;
}
export interface WebhookAttempt {
  id: string;
  webhookId: string;
}
export interface WebhookIngressStatus {
  ok?: boolean;
}

interface AppState {
  bots: Bot[];
  groups: Group[];
  instances: InstanceInfo[];
  config: ConfigStatus | null;
  selectedId: string;
  activeView: "chat" | "routines";
  routines: Routine[];
  routineRuns: RoutineRun[];
  webhooks: WebhookTrigger[];
  webhookAttempts: WebhookAttempt[];
  webhookIngress: WebhookIngressStatus | null;
  settingsOpen: boolean;
  pluginsOpen: boolean;
  computerOpen: boolean;
  appSettingsOpen: boolean;
  appSettingsSection: AppSettingsSection;
  screens: Record<string, { png: string; mime: string }>;
  provisioning: Record<string, boolean>;
  connected: boolean;
  error: string | null;
  mascotMotion: {
    botId: string;
    nonce: number;
    kind: Exclude<MausMotion, "none">;
  } | null;
}

/** OpenMausBot dispatch surface — extra fields are ignored by the team adapter. */
type Action = {
  type: string;
  [key: string]: any;
};

const COLORS: MausColor[] = [
  "green",
  "blue",
  "orange",
  "purple",
  "cyan",
  "pink",
  "yellow",
  "teal",
];

const initialState: AppState = {
  bots: [],
  groups: [],
  instances: [
    {
      instanceId: "team-stub",
      driverKind: "team",
      displayName: "rivet-team stub",
      snapshot: { state: "available", authenticated: true },
      models: { default: "stub", options: [{ id: "stub", label: "stub" }] },
    },
  ],
  config: {
    composio: { configured: false },
    box: { configured: false },
    tts: { configured: true, ready: true, voice: "rivet" },
    profile: { name: "household", email: "" },
  },
  selectedId: "",
  activeView: "chat",
  routines: [],
  routineRuns: [],
  webhooks: [],
  webhookAttempts: [],
  webhookIngress: null,
  settingsOpen: false,
  pluginsOpen: false,
  computerOpen: false,
  appSettingsOpen: false,
  appSettingsSection: "general",
  screens: {},
  provisioning: {},
  connected: true,
  error: null,
  mascotMotion: null,
};

function updateBot(state: AppState, botId: string, fn: (b: Bot) => Bot): AppState {
  return { ...state, bots: state.bots.map((b) => (b.id === botId ? fn(b) : b)) };
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "hydrate": {
      const bots = (action.bots ?? []) as Bot[];
      const groups = (action.groups ?? []) as Group[];
      const known = (id: string) => bots.some((b) => b.id === id);
      const selectedId =
        state.selectedId && known(state.selectedId) ? state.selectedId : (bots[0]?.id ?? "");
      return { ...state, bots, groups, selectedId, connected: true };
    }
    case "select":
      return { ...state, activeView: "chat", selectedId: String(action.id ?? "") };
    case "messageAdded": {
      return {
        ...state,
        bots: state.bots.map((b) => {
          if (b.threadId !== action.threadId) return b;
          if (b.messages.some((m) => m.id === action.message.id)) return b;
          return { ...b, messages: [...b.messages, action.message], busy: action.message.role === "bot" ? false : b.busy };
        }),
      };
    }
    case "setBusy":
      return updateBot(state, action.botId, (b) => ({ ...b, busy: action.busy }));
    case "botPatched":
      return updateBot(state, action.bot.id, (b) => ({ ...b, ...action.bot }));
    case "botAdded":
      return { ...state, bots: [...state.bots, action.bot] };
    case "deleteBot": {
      const bots = state.bots.filter((b) => b.id !== action.botId);
      return { ...state, bots, selectedId: state.selectedId === action.botId ? (bots[0]?.id ?? "") : state.selectedId };
    }
    case "updateBot":
      return updateBot(state, action.botId, (b) => ({ ...b, ...action.patch }));
    case "markUnread":
      return updateBot(state, action.botId, (b) => ({ ...b, unread: true }));
    case "toggleSettings":
      return { ...state, settingsOpen: action.open ?? !state.settingsOpen };
    case "togglePlugins":
      return { ...state, pluginsOpen: action.open ?? !state.pluginsOpen };
    case "toggleComputer":
      return { ...state, computerOpen: action.open ?? !state.computerOpen };
    case "toggleAppSettings":
      return {
        ...state,
        appSettingsOpen: action.open ?? !state.appSettingsOpen,
        appSettingsSection: (action.section as AppSettingsSection | undefined) ?? state.appSettingsSection,
      };
    case "configStatus":
      return { ...state, config: action.config ?? state.config };
    case "showRoutines":
      return { ...state, activeView: "routines" };
    case "error":
      return { ...state, error: action.message };
    case "connected":
      return { ...state, connected: action.value };
    default:
      return state;
  }
}

/**
 * Chat send path used by the taken Composer (`dispatch({ type: "send" })`).
 * Always posts on the rivet-team gateway. Never fetch()es OpenMausBot /api/bots.
 */
export async function sendOnTeamGateway(botId: string, text: string): Promise<void> {
  const g = getGateway();
  const userId = useTeam.getState().userId;
  const persona = g.listPersonas(userId).find((p) => p.id === botId);
  if (!persona) throw new Error(`unknown persona ${botId}`);
  await g.postMessage(persona.threadId, { text, userId, agent: botId });
}

/** OpenMausBot `api()` — must not carry chat. Chat is sendOnTeamGateway. */
export async function api(path: string, _init?: RequestInit): Promise<any> {
  if (/\/api\/bots\/[^/]+\/messages/.test(path) || path.startsWith("/api/threads/")) {
    throw new Error("chat goes through team gateway, not OpenMausBot harness");
  }
  if (path === "/api/tts/voices") {
    const synth = globalThis.window?.speechSynthesis;
    const voices = synth
      ? synth.getVoices().map((v) => ({ id: v.voiceURI, label: v.name, description: v.lang }))
      : [];
    return { voices };
  }
  return {};
}

interface StreamState {
  streaming: Record<string, string>;
  reasoning: Record<string, string>;
}
const EMPTY_STREAM: StreamState = { streaming: {}, reasoning: {} };
const StreamContext = createContext<StreamState>(EMPTY_STREAM);

export function useStreaming() {
  return useContext(StreamContext);
}

const StoreContext = createContext<{
  state: AppState;
  dispatch: Dispatch<Action>;
  refreshInstances: () => Promise<void>;
} | null>(null);

function personaColor(id: string, index: number): MausColor {
  if (id.includes("research")) return "green";
  if (id.includes("summarizer")) return "blue";
  if (id.includes("informatics")) return "orange";
  return COLORS[index % COLORS.length];
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, rawDispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [stream] = useState<StreamState>(EMPTY_STREAM);

  useEffect(() => {
    const g = getGateway();
    const userId = useTeam.getState().userId;
    const personas = g.listPersonas(userId);
    let cancelled = false;
    void Promise.all(
      personas.map(async (p, i) => {
        const res = await g.sessionMessages(p.threadId);
        const messages: Message[] = res.messages.map((m) => ({
          id: m.id,
          role: m.role === "user" ? "user" : "bot",
          kind: "text" as const,
          text: m.text,
          at: m.ts,
        }));
        return {
          id: p.id,
          threadId: p.threadId,
          name: p.name,
          title: p.sample ? "sample" : "",
          description: p.systemPrompt,
          notifications: false,
          color: personaColor(p.id, i),
          unread: false,
          modelSelection: { instanceId: "team-stub", model: "stub" },
          messages,
        } satisfies Bot;
      }),
    ).then((bots) => {
      if (!cancelled) rawDispatch({ type: "hydrate", bots, groups: [] });
    });

    const closes = personas.map((p) =>
      g.watchSessions((frame) => {
        if (frame.kind === "stream") {
          if (frame.event.type === "status" && frame.event.metadata?.card === "working") {
            rawDispatch({ type: "setBusy", botId: p.id, busy: true });
          }
          if (frame.event.type === "done" || frame.event.type === "error") {
            rawDispatch({ type: "setBusy", botId: p.id, busy: false });
          }
          return;
        }
        if (frame.kind === "message") {
          rawDispatch({
            type: "messageAdded",
            threadId: frame.sessionId,
            message: {
              id: frame.id,
              role: frame.role === "user" ? "user" : "bot",
              kind: "text",
              text: frame.text,
              at: frame.ts,
            },
          });
        }
      }, p.threadId),
    );
    return () => {
      cancelled = true;
      closes.forEach((c) => c.close());
    };
  }, []);

  const dispatch = useMemo(() => {
    const wrapped: Dispatch<Action> = (action) => {
      rawDispatch(action);
      if (action.type === "send") {
        void sendOnTeamGateway(action.botId, action.text).catch((err: Error) => {
          rawDispatch({ type: "error", message: err.message });
        });
      }
    };
    return wrapped;
  }, []);

  const refreshInstances = useCallback(async () => {}, []);
  const value = useMemo(() => ({ state, dispatch, refreshInstances }), [state, dispatch, refreshInstances]);
  return (
    <StoreContext.Provider value={value}>
      <StreamContext.Provider value={stream}>{children}</StreamContext.Provider>
    </StoreContext.Provider>
  );
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore outside provider");
  return ctx;
}

export function formatTime(at: number) {
  return new Date(at).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}
