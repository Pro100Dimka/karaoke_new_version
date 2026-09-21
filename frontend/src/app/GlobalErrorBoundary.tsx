import { AlertTriangle, RotateCcw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import type { Language } from "../contracts/models";
import { text } from "../i18n/messages";

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

const fallbackLanguage = (): Language => {
  const locale = navigator.language.toLowerCase();
  if (locale.startsWith("uk")) return "uk";
  if (locale.startsWith("ru")) return "ru";
  return "en";
};

const ErrorFallback = () => {
  const language = fallbackLanguage();

  return (
    <main className="fatalError" role="alert">
      <AlertTriangle aria-hidden size={42} />
      <h1>{text(language, "somethingWrong")}</h1>
      <p>{text(language, "interfaceFailed")}</p>
      <button type="button" className="fatalReloadButton" onClick={() => window.location.reload()}>
        <RotateCcw aria-hidden size={17} />
        {text(language, "reloadInterface")}
      </button>
    </main>
  );
};

export class GlobalErrorBoundary extends Component<Props, State> {
  public override state: State = { failed: false };

  public static getDerivedStateFromError(): State {
    return { failed: true };
  }

  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Unhandled renderer error", error, info.componentStack);
  }

  public override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <ErrorFallback />;
  }
}
