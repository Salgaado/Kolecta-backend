import { Controller, Get } from '@nestjs/common';
import { CategoriesService } from './categories.service';

@Controller('api/categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  // ── GET /api/categories — Público: lista de categorias ──────────────────────
  @Get()
  async findAll() {
    return { data: await this.categoriesService.findAll() };
  }
}
