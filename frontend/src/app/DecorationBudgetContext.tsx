import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { DecorationBudget } from "./decorationBudget";
import { useAppOnScreen } from "./useAppOnScreen";

const Context = createContext(false);
export const useDecorationBudget = () => useContext(Context);

/** Animation must leave enough GPU time for typing, scrolling and the audio controls. */
export const DecorationBudgetProvider = ({ children }: { children: ReactNode }) => {
  const active = useAppOnScreen();
  const budget = useRef(new DecorationBudget());
  const [limited, setLimited] = useState(false);
  useEffect(() => {
    if (!active || limited) return;
    budget.current.resetTiming();
    let frame = 0;
    let previous = 0;
    const tick = (now: number) => {
      if (previous && budget.current.sample(now - previous)) {
        setLimited(true);
        return;
      }
      previous = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, limited]);
  return <Context.Provider value={limited}>{children}</Context.Provider>;
};
