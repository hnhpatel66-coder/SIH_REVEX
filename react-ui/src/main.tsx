import React from "react";
import { createRoot } from "react-dom/client";
import LoadingButtonDemo from "../../components/loading-button-demo";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LoadingButtonDemo />
  </React.StrictMode>,
);
