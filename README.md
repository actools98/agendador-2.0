# Agendador de citas
Node + Express + SQLite. Variables: `ADMIN_PASSWORD` (obligatoria), `DATA_DIR` (por defecto `./data`, en Docker `/data`).
- Clientes: `/` (o `/?s=AAAA-MM-DD` para una semana concreta)
- Administrador: `/admin`
Local: `npm install && ADMIN_PASSWORD=algo npm start`
BUSINESS_NAME: `Enviroment variables, Nombre de Cliente`
NOTIFY EMAIL: `Enviroment variables, agregar correo del cliente`
