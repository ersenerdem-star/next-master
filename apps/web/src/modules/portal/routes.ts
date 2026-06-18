import { lazy } from "react";

export const PortalWorkspacePage = lazy(() =>
  import("./pages/PortalPage").then((module) => ({ default: module.PortalPage })),
);
