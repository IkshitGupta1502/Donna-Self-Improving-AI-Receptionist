// Serves the static dashboards in web/ (Ops at "/", Snoopy at "/snoopy/") so `npm run live` needs no second terminal.
import path from "path";
import express from "express";

export function startDashboard(port: number): Promise<string> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.static(path.resolve(__dirname, "../web")));
    const server = app.listen(port, () => resolve(`http://localhost:${port}`));
    server.on("error", (err: NodeJS.ErrnoException) => {
      console.log(
        err.code === "EADDRINUSE"
          ? `! Port ${port} is already in use, so the dashboards are not served. Stop whatever uses it, or set DASHBOARD_PORT.`
          : `! Dashboard server failed: ${err.message}`
      );
      resolve("");
    });
  });
}
