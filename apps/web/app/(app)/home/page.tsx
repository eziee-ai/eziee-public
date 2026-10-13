"use client";

import { useSearchParams } from "next/navigation";
import { ChatView } from "@/components/chat/ChatView";
import { useNewChatGeneration } from "@/lib/chat/newChat";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function HomePage() {
  const generation = useNewChatGeneration();
  // "New chat in folder" opens /home?folder=<id>; the server files the chat there only if the folder is the caller's.
  const folder = useSearchParams().get("folder");
  const folderId = folder && UUID.test(folder) ? folder : null;
  return <ChatView key={`new-${generation}-${folderId ?? ""}`} chatId={null} initialMessages={[]} folderId={folderId} />;
}
