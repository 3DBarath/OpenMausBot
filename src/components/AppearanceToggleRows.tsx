import { setAsciiBackground, useAsciiBackground } from "@/lib/ascii-background-preference";
import { t } from "@/lib/i18n";
import { setColorUserBubbles, useColorUserBubbles } from "@/lib/user-bubble-preference";
import { SettingRow, Switch } from "./SettingsPrimitives";

export function ColorUserBubblesRow() {
  const enabled = useColorUserBubbles();
  return (
    <SettingRow title={t("settings.userBubbles.title")} subtitle={t("settings.userBubbles.subtitle")}>
      <Switch
        checked={enabled}
        aria-label={t("settings.userBubbles.aria")}
        onClick={() => setColorUserBubbles(!enabled)}
      />
    </SettingRow>
  );
}

export function AnimatedBackgroundRow() {
  const enabled = useAsciiBackground();
  return (
    <SettingRow title={t("settings.animatedBackground.title")} subtitle={t("settings.animatedBackground.subtitle")}>
      <Switch
        checked={enabled}
        aria-label={t("settings.animatedBackground.aria")}
        onClick={() => setAsciiBackground(!enabled)}
      />
    </SettingRow>
  );
}
