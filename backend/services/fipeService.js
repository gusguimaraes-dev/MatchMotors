// backend/services/fipeService.js
const axios = require("axios");

const baseURL = "https://fipe.parallelum.com.br/api/v2";

// --- helpers ---
const toArray = (resp, altKeys = []) => {
  // resp pode ser: array | { models: [...] } | { modelos: [...] } | { data: [...] } | { ... } | null
  if (Array.isArray(resp)) return resp;
  if (resp && typeof resp === "object") {
    for (const k of [
      "models",
      "modelos",
      "brands",
      "marcas",
      "years",
      "anos",
      "data",
      ...altKeys,
    ]) {
      if (Array.isArray(resp[k])) return resp[k];
    }
  }
  return []; // fallback seguro
};

const sameCode = (a, b) => String(a) === String(b);

const pickNameByCode = (list, code, nameKey = "name", codeKey = "code") => {
  const found = list.find((x) => sameCode(x?.[codeKey], code));
  return found?.[nameKey] ?? code;
};

// Alguns anos vêm "2013-1" (gasolina) / "2013-2" (álcool) etc. Se quiser só o rótulo da FIPE:
const getYearLabel = (list, code) => {
  const found = list.find((x) => sameCode(x?.code, code));
  // A FIPE normalmente devolve algo como { code: "2013-1", name: "2013 Gasolina" }
  return found?.name ?? code;
};

// GET com normalização e fallback
const getFipe = async (path, altKeys = []) => {
  try {
    const { data } = await axios.get(`${baseURL}/${path}`, { timeout: 12000 });
    return toArray(data, altKeys);
  } catch (error) {
    // Loga com contexto do path para depuração
    console.error(
      `FIPE GET FAIL [${path}]:`,
      error?.response?.status || error?.code || error?.message
    );
    return []; // devolve array vazio para não quebrar .find/.map
  }
};

// --- API pública ---
exports.fetchFromFipe = async (path) => {
  // Mantém compatibilidade com seu código existente, mas já normaliza para array ou objeto “cru” caso seja útil.
  try {
    const { data } = await axios.get(`${baseURL}/${path}`, { timeout: 12000 });
    return data;
  } catch (error) {
    console.error(
      "Erro ao buscar dados da FIPE:",
      error?.response?.status || error?.message
    );
    // Importante: não retorne { error } aqui, pois isso quebra quem espera array
    return null; // deixa o caller decidir o fallback
  }
};

// Map de aliases -> tipos da FIPE v2
const TYPE_MAP = {
  cars: "cars",
  car: "cars",
  carro: "cars",
  carros: "cars",
  motorcycles: "motorcycles",
  motorcycle: "motorcycles",
  moto: "motorcycles",
  motos: "motorcycles",
  trucks: "trucks",
  truck: "trucks",
  caminhao: "trucks",
  caminhoes: "trucks",
  caminhões: "trucks",
};
const toApiType = (t) => TYPE_MAP[String(t || "cars").toLowerCase()] || "cars";

const resolveYear = (years, ano) => {
  const list = Array.isArray(years) ? years : [];
  const s = String(ano ?? "");
  let found = list.find((y) => sameCode(y.code, s));
  if (!found) {
    const y = s.match(/^\d{4}/)?.[0];
    if (y) found = list.find((e) => String(e.code).startsWith(`${y}-`));
  }
  return found || list[0] || { code: s, name: s };
};

exports.formatarCarro = async ({ tipo, marca, modelo, ano }) => {
  // Guarda de parâmetros para evitar 400 na FIPE
  if (!tipo || !marca || !ano || !modelo) {
    console.warn("formatarCarro: parâmetros incompletos", {
      tipo,
      marca,
      ano,
      modelo,
    });
    return { tipo, marca, modelo, ano }; // devolve “cru”, sem chamar a FIPE
  }

  // Tenta no tipo informado; se falhar, tenta o alternativo (cars <-> motorcycles)
  const first = toApiType(tipo);
  const fallback = first === "cars" ? "motorcycles" : "cars";
  const typesToTry = [first, fallback];

  try {
    for (const tipoAPI of typesToTry) {
      // 1) Marcas
      const brandsRaw = await getFipe(`${tipoAPI}/brands`, [
        "brands",
        "marcas",
      ]);
      const nomeMarca = pickNameByCode(brandsRaw, marca, "name", "code");

      // 2) Modelos (marca)
      const modelsRaw = await getFipe(`${tipoAPI}/brands/${marca}/models`, [
        "models",
        "modelos",
      ]);
      if (!modelsRaw.length) continue; // tenta o outro tipo
      const nomeModelo = pickNameByCode(modelsRaw, modelo, "name", "code");

      // 3) Anos (modelo)
      const yearsRaw = await getFipe(
        `${tipoAPI}/brands/${marca}/models/${modelo}/years`,
        ["years", "anos"]
      );
      if (!yearsRaw.length) continue;
      const year = resolveYear(yearsRaw, ano); // casa "2019-5" ou cai para "2019-*"

      return {
        tipo:
          tipoAPI === "motorcycles"
            ? "moto"
            : tipoAPI === "trucks"
            ? "caminhão"
            : "carro",
        marca: nomeMarca,
        modelo: nomeModelo,
        ano: year.name, // rótulo completo ex.: "2019 Gasolina"
        ano_label: year.name, // alias útil p/ services
        ano_codigo: year.code, // ex.: "2019-1"
      };
    }
    // se nenhuma tentativa deu certo, cai no fallback abaixo
  } catch (err) {
    console.error("Erro ao formatar carro FIPE:", err?.message || err);
    // Fallback seguro (nunca lança para não derrubar o fluxo)
    return { tipo, marca, modelo, ano };
  }
};
