import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import {
  Badge, Button, Card, Checkbox, DataTable, DatabaseArt, Dialog, Header, IconButton, Landscape, LevelMeter,
  MessageBar, NeonWaves, Planet, ProgressBar, RotaryKnob, Select, ServerArt, Slider, Spectrum, Stack,
  StatusIndicator, Switch, Tabs, TextArea, TextField, ThemeProvider, Tooltip, Waveform,
} from "@ad-voice/ui";

it("renders the library in jsdom", () => {
  render(
    <ThemeProvider>
      <Stack gap={2}>
        <Tabs value="a" onValueChange={() => undefined} items={[{ value: "a", label: "A" }, { value: "b", label: "B" }]} />
        <Card title="Карта" icon="settings">x</Card>
        <Header title="Заголовок" level={2} />
        <TextField label="Имя" />
        <TextArea label="Текст" />
        <Select label="Выбор" options={["a", "b"]} />
        <Switch label="Свитч" />
        <Checkbox label="Галка" indeterminate />
        <Slider label="Громкость" />
        <RotaryKnob label="Шум" />
        <Button icon="save">Сохранить</Button>
        <IconButton icon="info" label="Инфо" />
        <Tooltip content="подсказка"><button type="button">t</button></Tooltip>
        <ProgressBar value={40} />
        <MessageBar tone="error">Ошибка</MessageBar>
        <StatusIndicator status="success" label="Ок" />
        <Badge tone="success">Готово</Badge>
        <LevelMeter value={40} />
        <Waveform />
        <DataTable columns={["a"]} rows={[["1"]]} selectable searchable pageSize={2} />
        <Landscape /><Planet /><NeonWaves /><Spectrum /><DatabaseArt /><ServerArt />
        <Dialog open title="Диалог" cancelLabel={false} confirmLabel={false}>тело</Dialog>
      </Stack>
    </ThemeProvider>,
  );
  expect(screen.getByLabelText("Имя")).toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "Свитч" })).toBeInTheDocument();
  expect(screen.getByRole("slider", { name: "Шум" })).toBeInTheDocument();
  expect(screen.getByText("тело")).toBeInTheDocument();
});
