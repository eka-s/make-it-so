/** The time of a message as shown in the conversation: yyyy/mm/dd hh:mm:ss, in the local time zone. */
export function formatMessageTime(iso: string): string {
  const d = new Date(iso);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
