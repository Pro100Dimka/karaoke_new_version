import { Grid } from "@neo-ui-kit/react";
import { AboutPanel } from "./about/index";
import { DiagnosticsPanel } from "./diagnostics/index";
import { HistoryPanel } from "./history/index";
import { StoragePanel } from "./storage/index";
import { useSubsystemHealth } from "./useSubsystemHealth";
import "./advanced.css";

export const AdvancedSettings = () => {
  const health = useSubsystemHealth();

  return (
    <Grid columns={12} gap={3}>
      <Grid span={{ base: "full", sm: 4 }}>
        <StoragePanel
          usage={health.backend?.storage ?? null}
          onChanged={health.refresh}
        />
      </Grid>
      <Grid span={{ base: "full", sm: 4 }}>
        <DiagnosticsPanel health={health} />
      </Grid>
      <Grid span={{ base: "full", sm: 4 }}>
        <AboutPanel health={health} />
      </Grid>
      <Grid span={{ base: "full" }}>
        <HistoryPanel />
      </Grid>
    </Grid>
  );
};
