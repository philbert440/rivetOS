import { useState, type JSX } from 'react'
import { Image as ImageIcon, Paperclip } from 'lucide-react'
import type { TranscriptAttachment } from '@rivetos/types'
import { useGateway } from '../lib/use-gateway.js'
import { attachmentView } from '../lib/transcript-attachments.js'

/** The files a user turn was sent with, above its bubble. */
export function TranscriptAttachments(props: { attachments: TranscriptAttachment[] }): JSX.Element {
  const gateway = useGateway()
  const uploadUrl = (id: string): string => gateway.uploadUrl(id)
  return (
    <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
      {props.attachments.map((attachment, i) => (
        <SentFile
          key={`${attachment.uploadId ?? attachment.name ?? attachment.mediaType}:${String(i)}`}
          attachment={attachment}
          uploadUrl={uploadUrl}
        />
      ))}
    </div>
  )
}

function SentFile(props: {
  attachment: TranscriptAttachment
  uploadUrl: (id: string) => string
}): JSX.Element {
  const [failed, setFailed] = useState(false)
  const view = attachmentView(props.attachment, props.uploadUrl, failed)
  if (view.kind === 'image') {
    return (
      <img
        src={view.src}
        alt={view.label}
        title={view.label}
        loading="lazy"
        onError={() => setFailed(true)}
        className="max-h-48 max-w-60 rounded-xl border border-line object-cover"
      />
    )
  }
  const Icon = view.image ? ImageIcon : Paperclip
  return (
    <span
      className="flex items-center gap-1.5 rounded-lg border border-transparent bg-panel-2 px-2.5 py-1 text-xs text-ink classic:border-em-dim/60 classic:bg-transparent classic:px-2 classic:py-0.5 classic:text-[11px]"
      title={view.label}
    >
      <Icon className="size-3" />
      <span className="max-w-40 truncate">{view.label}</span>
    </span>
  )
}
