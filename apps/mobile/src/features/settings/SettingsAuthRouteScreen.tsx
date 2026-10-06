import { Linking, View } from "react-native";
import { useAuth } from "../accounts/AccountProvider";
import { OTTER_ACCOUNTS_URL } from "@t3tools/shared/otterAccounts";
import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsRow } from "./components/SettingsRow";
import { T3ConnectProfilePage } from "../cloud/T3ConnectProfilePage";

export function SettingsAuthRouteScreen() {
  const { isLoaded, isSignedIn, user, error, signIn, signOut } = useAuth();
  return (
    <ScreenScrollView contentContainerClassName="gap-4 px-5 py-4">
      <SettingsSection title="Otter account">
        <SettingsRow
          icon="person.crop.circle"
          label={isSignedIn ? (user?.name ?? "Otter account") : "Sign in with Otter"}
          value={user?.email}
          disabled={!isLoaded}
          onPress={() => {
            if (!isSignedIn) void signIn();
          }}
        />
        {isSignedIn ? (
          <>
            <SettingsRow
              icon="person.crop.circle"
              label="Manage Otter account"
              onPress={() =>
                void Linking.openURL(`${new URL(OTTER_ACCOUNTS_URL).origin}/otter/account`)
              }
            />
            <SettingsRow
              icon="person.crop.circle"
              label="Sign out of this device"
              onPress={() => void signOut()}
            />
          </>
        ) : null}
      </SettingsSection>
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-red-500">
          {error}
        </Text>
      ) : null}
      {isSignedIn ? (
        <View className="min-h-80">
          <T3ConnectProfilePage />
        </View>
      ) : null}
    </ScreenScrollView>
  );
}
