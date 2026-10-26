import type { Metadata } from "next";

import NewRunForm from "@/components/NewRunForm";

export const metadata: Metadata = { title: "New run · Patchwork Office" };

export default function NewRunPage() {
  return <NewRunForm />;
}
