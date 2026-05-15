import { Controller, Get, Param, Query } from '@nestjs/common';
import { SellersService } from './sellers.service';

@Controller('api/sellers')
export class SellersController {
  constructor(private readonly sellersService: SellersService) {}

  @Get(':id')
  async getProfile(@Param('id') id: string) {
    return this.sellersService.getSellerProfile(id);
  }

  @Get(':id/listings')
  async getListings(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('categoryId') categoryId?: string,
  ) {
    const pageNumber = page ? parseInt(page, 10) : 1;
    const limitNumber = limit ? parseInt(limit, 10) : 10;
    return this.sellersService.getSellerListings(
      id,
      pageNumber,
      limitNumber,
      categoryId,
    );
  }

  @Get(':id/reviews')
  async getReviews(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const pageNumber = page ? parseInt(page, 10) : 1;
    const limitNumber = limit ? parseInt(limit, 10) : 10;
    return this.sellersService.getSellerReviews(id, pageNumber, limitNumber);
  }
}
