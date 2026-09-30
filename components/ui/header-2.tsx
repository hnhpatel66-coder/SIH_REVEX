"use client";

import React from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MenuToggleIcon } from "@/components/ui/menu-toggle-icon";
import { useScroll } from "@/components/ui/use-scroll";

const publicLinks = [
  { label: "Home", href: "index.html" },
  { label: "Find a Ride", href: "find-ride.html" },
  { label: "Rent a Vehicle", href: "rental.html" },
];

export function Header() {
  const [open, setOpen] = React.useState(false);
  const scrolled = useScroll(10);

  React.useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  return (
    <header
      className={cn(
        "sticky top-0 z-50 mx-auto w-full border-b border-transparent bg-background/95 backdrop-blur-lg",
        scrolled && !open && "md:top-4 md:max-w-6xl md:rounded-md md:border-border md:shadow",
        open && "bg-background/90",
      )}
    >
      <nav className={cn("flex h-14 w-full items-center justify-between px-4 md:h-12", scrolled && "md:px-2")}>
        <a href="index.html" className="flex items-center gap-2 font-extrabold tracking-tight" aria-label="REVEX home">
          <img src="assets/revex-mark.png" alt="" aria-hidden="true" className="h-7 w-7 rounded-md object-contain" />
          <span>REVEX</span>
        </a>

        <div className="hidden items-center gap-2 md:flex">
          {publicLinks.map((link) => (
            <a key={link.href} className={buttonVariants({ variant: "ghost", size: "sm" })} href={link.href}>
              {link.label}
            </a>
          ))}
          <a className={buttonVariants({ variant: "outline", size: "sm" })} href="login.html">
            Sign In
          </a>
          <a className={buttonVariants({ size: "sm" })} href="register.html">
            Get Started
          </a>
        </div>

        <Button size="icon" variant="outline" onClick={() => setOpen(!open)} className="md:hidden" aria-label={open ? "Close navigation" : "Open navigation"}>
          <MenuToggleIcon open={open} className="size-5" duration={300} />
        </Button>
      </nav>

      <div
        className={cn(
          "fixed inset-x-0 top-14 bottom-0 z-50 border-y bg-background/90 backdrop-blur-lg md:hidden",
          open ? "block" : "hidden",
        )}
      >
        <div className="flex h-full w-full flex-col justify-between gap-y-2 p-4">
          <div className="grid gap-y-2">
            {publicLinks.map((link) => (
              <a key={link.href} className={buttonVariants({ variant: "ghost", className: "justify-start" })} href={link.href}>
                {link.label}
              </a>
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <a className={buttonVariants({ variant: "outline", className: "w-full" })} href="login.html">Sign In</a>
            <a className={buttonVariants({ className: "w-full" })} href="register.html">Get Started</a>
          </div>
        </div>
      </div>
    </header>
  );
}

export const WordmarkIcon = (props: React.ComponentProps<"svg">) => (
  <svg viewBox="0 0 84 24" fill="currentColor" {...props}>
    <text x="0" y="18" fontSize="18" fontWeight="800">REVEX</text>
  </svg>
);
