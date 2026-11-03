# Agendador de citas
Node + Express + SQLite. Variables: `ADMIN_PASSWORD` (obligatoria), `DATA_DIR` (por defecto `./data`, en Docker `/data`).
- Clientes: `/` (o `/?s=AAAA-MM-DD` para una semana concreta)
- Administrador: `/admin`
Local: `npm install && ADMIN_PASSWORD=algo npm start`
- BUSINESS_NAME: `Enviroment variables, Nombre de Cliente`
NOTIFY EMAIL: `Enviroment variables, agregar correo del cliente`
MAIL FROM: `es lo que el que separa la cita ve "nombre cliente vía <info@actols.com>`
 - Agregar El "PROFESSIONALS" Solo cuando hayan, de lo contrario se borrará siempre al no tener info dentro.
 - Agregar el Max users dependiendo de la situación.
 - agregar el ENABLE_SERVICES=true cuando corresponda
