import { useAuth } from "../../accounts/AccountProvider";

export function useT3ConnectAuthPrompt() {
  const { signIn, error } = useAuth();
  return {
    openAuthPrompt: () => {
      void signIn();
    },
    authPrompt: error ? (
      <p role="alert" className="text-xs text-destructive">
        {error}
      </p>
    ) : null,
  };
}
