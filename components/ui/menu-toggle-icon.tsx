import * as React from "react";
import { Menu, X } from "lucide-react";

export function MenuToggleIcon({
  open,
  className,
}: {
  open: boolean;
  className?: string;
  duration?: number;
}) {
  const Icon = open ? X : Menu;
  return <Icon className={className} aria-hidden="true" />;
}
