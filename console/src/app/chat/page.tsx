import { redirect } from "next/navigation";

// The chat now lives inside the unified console as a tab — keep this old URL
// working by sending it home.
export default function ChatRedirect() {
  redirect("/");
}
