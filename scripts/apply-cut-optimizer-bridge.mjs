import fs from "node:fs";

const APP_PATH =
  "src/app.js";

let source =
  fs.readFileSync(
    APP_PATH,
    "utf8"
  );

const importLine =
  'import bathroomProjectRoutes from "./routes/bathroomProject.routes.js";';

const mountLine =
  'app.use("/api/bathroom-projects", bathroomProjectRoutes);';

if (
  !source.includes(
    importLine
  )
) {
  const marker =
    "const app = express();";

  if (
    !source.includes(
      marker
    )
  ) {
    throw new Error(
      "No se encontró 'const app = express();' en src/app.js"
    );
  }

  source =
    source.replace(
      marker,
      `${importLine}\n\n${marker}`
    );
}

if (
  !source.includes(
    mountLine
  )
) {
  const preferredMarkers = [
    'app.use("/api/admin/pos", posRoutes);',
    'app.use("/api/account", accountRoutes);',
  ];

  let applied = false;

  for (
    const marker of
    preferredMarkers
  ) {
    if (
      source.includes(
        marker
      )
    ) {
      source =
        source.replace(
          marker,
          `${mountLine}\n\n${marker}`
        );

      applied = true;
      break;
    }
  }

  if (!applied) {
    throw new Error(
      "No se encontró un punto seguro para montar bathroomProjectRoutes en src/app.js"
    );
  }
}

fs.writeFileSync(
  APP_PATH,
  source,
  "utf8"
);

console.log(
  "✅ src/app.js actualizado"
);

console.log(
  "✅ /api/bathroom-projects montado"
);
