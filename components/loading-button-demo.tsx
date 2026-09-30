import { LoadingButton } from "@/components/ui/loading-button";

export default function LoadingButtonDemo() {
  return (
    <div className="flex min-h-[320px] w-full items-center justify-center p-8">
      <LoadingButton
        onAction={() => new Promise((resolve) => setTimeout(resolve, 1600))}
        pendingLabel="Publishing…"
        successLabel="Published"
        errorLabel="Try again"
      >
        Publish
      </LoadingButton>
    </div>
  );
}
