import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { setupPWA } from './pwa.js';
import "./styles.css";

createRoot(document.getElementById("root")).render(<App />);

setupPWA('SnapBot');
