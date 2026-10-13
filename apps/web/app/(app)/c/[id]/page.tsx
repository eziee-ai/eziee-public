import { notFound, redirect } from "next/navigation";
import { getChat, getDb } from "@repo/db";
import { ChatView } from "@/components/chat/ChatView";
import { currentAddress } from "@/lib/server/session";

/** A saved chat. Read on the server with the session's address, so another person's id is simply "not found". */
export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const address = await currentAddress();
  if (!address) redirect("/home");
  const found = await getChat(await getDb(), { address, chatId: id });
  if (!found) notFound();
  const { model, protocol, chainId } = found.chat;
  return <ChatView key={id} chatId={id} initialMessages={found.messages as never} savedSelection={{ model, protocol, chainId }} />;
}
