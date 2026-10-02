import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "./index.css";

import { createRoot } from "react-dom/client";

import { Radio } from "./radio";

createRoot(document.getElementById("root")!).render(<Radio />);
