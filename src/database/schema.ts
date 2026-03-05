import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  // O ID que vem do Clerk (ex: user_2Ppx...)
  id: text('id').primaryKey(),
  
  // Informações básicas espelhadas do Clerk
  email: text('email').notNull().unique(),
  name: text('name'),
  
  // Controle de permissões interno (buyer, seller, admin)
  role: text('role').notNull().default('buyer'),
  
  // Controle de datas usando milissegundos ou ISO (Drizzle no SQLite lida com nativos)
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});
