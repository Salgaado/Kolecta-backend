import { Inject, Injectable } from '@nestjs/common';
import { asc } from 'drizzle-orm';
import { LibSQLDatabase } from 'drizzle-orm/libsql';
import { DATABASE_CONNECTION } from '../database/database.module';
import { categories } from '../database/schema';

@Injectable()
export class CategoriesService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: LibSQLDatabase<any>,
  ) {}

  async findAll() {
    return this.db
      .select({
        id: categories.id,
        name: categories.name,
        slug: categories.slug,
        icon: categories.icon,
        parentId: categories.parentId,
      })
      .from(categories)
      .orderBy(asc(categories.name));
  }
}
