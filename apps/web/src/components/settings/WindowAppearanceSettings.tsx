import type { ClientSettingsPatch } from "@t3tools/contracts";
import type { CSSProperties } from "react";

import { isElectron } from "../../env";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { isMacPlatform } from "../../lib/utils";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function WindowRange({
  id,
  label,
  value,
  min,
  max,
  unit = "",
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  const ratio = (value - min) / (max - min);
  const style = {
    "--settings-slider-progress": `${ratio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
  } as CSSProperties;

  return (
    <div className="flex w-full items-center gap-3 sm:w-52">
      <output
        className="min-w-12 text-right font-mono text-xs tabular-nums text-muted-foreground"
        htmlFor={id}
      >
        {value}
        {unit}
      </output>
      <input
        id={id}
        type="range"
        aria-label={label}
        className="settings-slider min-w-0 flex-1"
        min={min}
        max={max}
        step={1}
        style={style}
        value={value}
        onChange={(event) => {
          const next = Number(event.currentTarget.value);
          if (Number.isInteger(next) && next >= min && next <= max) onChange(next);
        }}
      />
    </div>
  );
}

export function WindowAppearanceSettings() {
  const settings = useClientSettings();
  const supportsGlass = isElectron && isMacPlatform(navigator.platform);
  const translucent = settings.windowMaterial === "translucent";
  const update = (patch: ClientSettingsPatch) => {
    void updateClientSettings(patch).catch(() => {
      toastManager.add({ type: "error", title: "Could not save appearance settings" });
    });
  };

  return (
    <SettingsSection id="appearance-window" title="Window">
      {supportsGlass ? (
        <>
          <SettingsRow
            {...searchableSetting("window-material")}
            description="Choose a solid window or glass with the desktop visible behind it."
            control={
              <div className="w-full sm:w-40">
                <Select
                  value={settings.windowMaterial}
                  onValueChange={(value) => {
                    if (value === "solid" || value === "translucent")
                      update({ windowMaterial: value });
                  }}
                >
                  <SelectTrigger size="sm" className="w-full" aria-label="Window material">
                    <SelectValue>{translucent ? "Translucent" : "Solid"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="solid">Solid</SelectItem>
                    <SelectItem value="translucent">Translucent</SelectItem>
                  </SelectPopup>
                </Select>
              </div>
            }
          />
          {translucent ? (
            <>
              <SettingsRow
                {...searchableSetting("window-sidebar-only")}
                description="Keep the chat surface solid and make only the sidebar transparent."
                control={
                  <Switch
                    aria-label="Sidebar only"
                    checked={settings.windowSidebarOnly}
                    onCheckedChange={(windowSidebarOnly) => update({ windowSidebarOnly })}
                  />
                }
              />
              <SettingsRow
                {...searchableSetting("setting-window-opacity")}
                description="Control how much of the desktop shows through the window."
                control={
                  <WindowRange
                    id="window-opacity"
                    label="Window opacity"
                    min={15}
                    max={100}
                    value={settings.windowOpacity}
                    unit="%"
                    onChange={(windowOpacity) => update({ windowOpacity })}
                  />
                }
              />
              <SettingsRow
                {...searchableSetting("setting-window-blur")}
                description="Soften the desktop behind the window."
                control={
                  <WindowRange
                    id="window-blur"
                    label="Window blur"
                    min={0}
                    max={64}
                    value={settings.windowBlur}
                    onChange={(windowBlur) => update({ windowBlur })}
                  />
                }
              />
            </>
          ) : null}
        </>
      ) : null}
      <SettingsRow
        {...searchableSetting("ascii-background")}
        description="Show the animated ASCII waves in new chats."
        control={
          <Switch
            aria-label="Animated background"
            checked={settings.showAsciiBackground}
            onCheckedChange={(showAsciiBackground) => update({ showAsciiBackground })}
          />
        }
      />
    </SettingsSection>
  );
}
