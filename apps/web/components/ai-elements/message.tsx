"use client";

// Vendored from Vercel AI Elements (registry.ai-sdk.dev/message.json, Apache-2.0) and TRIMMED to the three
// pieces this app renders. Branching, attachments and the action toolbar were removed unused; the kept code
// is unchanged. `MessageResponse` renders model output through Streamdown: sanitized markdown, no raw HTML.

import { cn } from "@/lib/utils";
import type { UIMessage } from "ai";
import type { ComponentProps, HTMLAttributes } from "react";
import { memo } from "react";
import { Streamdown, type Components } from "streamdown";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full max-w-[95%] flex-col gap-2",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "is-user:dark flex w-fit max-w-full min-w-0 flex-col gap-2 overflow-hidden text-sm",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:text-foreground",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

/**
 * What the model writes may repeat text a stranger wrote: a token's onchain name, a pool's label. Markdown
 * turns that into requests and destinations, so two things are taken away from it here.
 *
 * An image is an outbound request the moment it renders, with whatever the model put in its URL (an address,
 * a balance). Nothing in this app needs the model to show a picture, so no markdown image is ever loaded.
 *
 * A link's text says one thing and its address another. Every link asks first, showing the real address.
 */
const SAFE_COMPONENTS: Components = {
  img: ({ alt }) => <span className="text-xs text-muted-foreground">[image not shown{typeof alt === "string" && alt ? `: ${alt}` : ""}]</span>,
};
const LINK_SAFETY = { enabled: true } as const;

export const MessageResponse = memo(
  ({ className, components, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn(
        "size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className
      )}
      linkSafety={LINK_SAFETY}
      {...props}
      // Last, so a caller can add components but never bring images back.
      components={{ ...components, ...SAFE_COMPONENTS }}
    />
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children
);

MessageResponse.displayName = "MessageResponse";
